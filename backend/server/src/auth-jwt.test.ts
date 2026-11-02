// SE-11 (SE-06 F-7): the production Cognito path. jose verification
// failures (expired, malformed, bad signature, wrong issuer, no matching
// key) must surface as 401s through the central error middleware — before
// SE-11 they propagated as plain Errors and became 500 internal_error,
// polluting alerting and telling clients to retry a dead token. Non-jose
// failures (server misconfiguration) stay 500s.
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Production auth path: dev bypass off, pool + client configured, all
// before auth.js evaluates (module-level env reads).
vi.hoisted(() => {
  process.env.CF_DEV_AUTH = 'false';
  process.env.COGNITO_USER_POOL_ID = 'pool-1';
  process.env.COGNITO_CLIENT_ID = 'client-1';
});

vi.mock('./db.js', () => ({
  one: vi.fn(),
  q: vi.fn(),
  exec: vi.fn(),
  uid: () => 'uid-1',
}));

vi.mock('jose', () => {
  class JOSEError extends Error {
    code = 'ERR_JOSE_GENERIC';
  }
  class JWTExpired extends JOSEError {
    code = 'ERR_JWT_EXPIRED';
  }
  class JWTInvalid extends JOSEError {
    code = 'ERR_JWT_INVALID';
  }
  return {
    createRemoteJWKSet: vi.fn(() => ({})),
    jwtVerify: vi.fn(),
    errors: { JOSEError, JWTExpired, JWTInvalid },
  };
});

import { jwtVerify, errors as joseErrors } from 'jose';
import { one, q, exec } from './db.js';
import { requireAuth } from './auth.js';
import { HttpError } from './errors.js';

const jwtVerifyMock = vi.mocked(jwtVerify);
const oneMock = vi.mocked(one);
const qMock = vi.mocked(q);
const execMock = vi.mocked(exec);

function res(): any {
  return { status: vi.fn().mockReturnThis(), json: vi.fn() };
}

const reqWith = (token?: string): any => ({
  headers: token ? { authorization: `Bearer ${token}` } : {},
});

/** The error requireAuth forwarded to the error middleware, if any. */
function forwardedError(next: ReturnType<typeof vi.fn>): any {
  return next.mock.calls[0]?.[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  oneMock.mockResolvedValue(undefined);
  qMock.mockResolvedValue([]);
  execMock.mockResolvedValue(1);
});

describe('requireAuth (Cognito path — SE-11 jose error mapping)', () => {
  it('maps an expired token to 401 unauthorized, not 500', async () => {
    jwtVerifyMock.mockRejectedValue(new joseErrors.JWTExpired('"exp" claim timestamp check failed', {} as any));
    const next = vi.fn();
    await requireAuth(reqWith('tok'), res(), next);
    const err = forwardedError(next);
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(401);
    expect(err.code).toBe('unauthorized');
    // The jose detail (which claim failed) never reaches the client line.
    expect(err.message).toBe('Invalid or expired access token');
    expect(err.message).not.toContain('claim');
  });

  it('maps a bad-signature / malformed token to the same generic 401', async () => {
    jwtVerifyMock.mockRejectedValue(new joseErrors.JWTInvalid('signature verification failed'));
    const next = vi.fn();
    await requireAuth(reqWith('tok'), res(), next);
    const err = forwardedError(next);
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(401);
    expect(err.message).toBe('Invalid or expired access token');
  });

  it('lets non-jose failures propagate untouched (config errors stay 500s)', async () => {
    const boom = new Error('fetch failed');
    jwtVerifyMock.mockRejectedValue(boom);
    const next = vi.fn();
    await requireAuth(reqWith('tok'), res(), next);
    const err = forwardedError(next);
    expect(err).toBe(boom);
    expect(err).not.toBeInstanceOf(HttpError);
    expect(err.status).toBeUndefined();
  });

  it('rejects a missing bearer token with 401 before any verification', async () => {
    const next = vi.fn();
    await requireAuth(reqWith(), res(), next);
    expect(forwardedError(next)?.status).toBe(401);
    expect(jwtVerifyMock).not.toHaveBeenCalled();
  });

  it('rejects a non-access token with 401', async () => {
    jwtVerifyMock.mockResolvedValue({
      payload: { sub: 'sub-1', token_use: 'id', client_id: 'client-1' },
    } as any);
    const next = vi.fn();
    await requireAuth(reqWith('tok'), res(), next);
    expect(forwardedError(next)?.status).toBe(401);
  });

  it('rejects a token issued for another app client with 401', async () => {
    jwtVerifyMock.mockResolvedValue({
      payload: { sub: 'sub-1', token_use: 'access', client_id: 'someone-else' },
    } as any);
    const next = vi.fn();
    await requireAuth(reqWith('tok'), res(), next);
    expect(forwardedError(next)?.status).toBe(401);
  });

  it('attaches the resolved user for a valid access token', async () => {
    jwtVerifyMock.mockResolvedValue({
      payload: { sub: 'sub-1', token_use: 'access', client_id: 'client-1', email: 'a@x.test' },
    } as any);
    oneMock.mockResolvedValue({
      id: 'u1', email: 'a@x.test', full_name: 'A', is_platform_admin: false, status: 'active', cognito_sub: 'sub-1',
    });
    const req = reqWith('tok');
    const next = vi.fn();
    await requireAuth(req, res(), next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(forwardedError(next)).toBeUndefined();
    expect(req.auth).toMatchObject({ userId: 'u1', email: 'a@x.test', isPlatformAdmin: false });
  });
});

describe('requireAuth first-login email linking (SE-10: email_verified required)', () => {
  const unlinkedRow = {
    id: 'u2', email: 'invitee@acme.test', full_name: 'Inv', is_platform_admin: false,
    status: 'active', cognito_sub: null,
  };

  /** sub lookup misses; the by-email lookup returns the pre-created row. */
  function mockUnlinkedUser() {
    oneMock.mockImplementation(async (sql: string) => {
      if (sql.includes('WHERE cognito_sub =')) return undefined;
      if (sql.includes('lower(email)')) return unlinkedRow;
      return undefined;
    });
  }

  const linkExec = () =>
    execMock.mock.calls.find(([sql]) => String(sql).includes('UPDATE users SET cognito_sub'));

  it.each([true, 'true'])('links the pre-created row when email_verified is %j', async (emailVerified) => {
    jwtVerifyMock.mockResolvedValue({
      payload: {
        sub: 'sub-9', token_use: 'access', client_id: 'client-1',
        email: 'invitee@acme.test', email_verified: emailVerified,
      },
    } as any);
    mockUnlinkedUser();
    const req = reqWith('tok');
    const next = vi.fn();
    await requireAuth(req, res(), next);
    expect(forwardedError(next)).toBeUndefined();
    expect(req.auth).toMatchObject({ userId: 'u2', email: 'invitee@acme.test' });
    expect(linkExec()?.[1]).toEqual(['sub-9', 'u2']);
  });

  it.each([false, undefined])(
    'does NOT link on an unverified email claim (email_verified=%j) — generic 403, no link write',
    async (emailVerified) => {
      jwtVerifyMock.mockResolvedValue({
        payload: {
          sub: 'sub-9', token_use: 'access', client_id: 'client-1',
          email: 'invitee@acme.test', email_verified: emailVerified,
        },
      } as any);
      mockUnlinkedUser();
      const next = vi.fn();
      await requireAuth(reqWith('tok'), res(), next);
      expect(forwardedError(next)?.status).toBe(403);
      expect(linkExec()).toBeUndefined();
    },
  );
});
