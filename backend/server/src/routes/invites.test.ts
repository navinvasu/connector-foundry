// SE-10 invite redemption: supertest over the invites router with a mocked
// DB. Asserts the F-5 contract — tokens are looked up by SHA-256 hash only,
// redemption is token-checked + email-bound + single-use, and unknown /
// expired / redeemed tokens are indistinguishable (one generic 404).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../db.js', () => ({
  one: vi.fn(),
  q: vi.fn(),
  exec: vi.fn(),
  uid: () => 'uid-1',
}));

let testAuth: any = null;
vi.mock('../auth.js', () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.auth = testAuth;
    next();
  },
}));

import { one, exec } from '../db.js';
import { invitesRouter } from './invites.js';
import { hashInviteToken, inviteHashMatches, inviteExpired, type InviteRow } from '../invites.js';

const oneMock = vi.mocked(one);
const execMock = vi.mocked(exec);

const TOKEN = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6';
const GENERIC_404 = { error: 'This invite link is invalid or has expired' };

const inviteRow = (over: Partial<InviteRow> = {}): InviteRow => ({
  membership_id: 'm1',
  customer_id: 'c1',
  workspace_name: 'Acme Workspace',
  role: 'editor',
  status: 'invited',
  invite_expires_at: new Date(Date.now() + 86400_000).toISOString(),
  invite_token_hash: hashInviteToken(TOKEN),
  invited_email: 'invitee@acme.test',
  inviter_name: 'Olivia Owner',
  inviter_email: 'owner@acme.test',
  ...over,
});

const inviteeAuth = { userId: 'u-inv', email: 'invitee@acme.test', fullName: 'Inv', isPlatformAdmin: false, memberships: [] };

function app() {
  const a = express();
  a.use(express.json());
  a.use('/v1/invites', invitesRouter);
  a.use((err: any, _req: any, res: any, _next: any) => {
    res.status(err?.status ?? 500).json({ error: err?.message ?? 'error' });
  });
  return a;
}

beforeEach(() => {
  vi.clearAllMocks();
  testAuth = inviteeAuth;
  oneMock.mockResolvedValue(undefined);
  execMock.mockResolvedValue(1);
});

describe('hashInviteToken / inviteHashMatches', () => {
  it('is the SHA-256 hex of the token (known vector), never the token itself', () => {
    // sha256('abc') — well-known test vector.
    expect(hashInviteToken('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(hashInviteToken(TOKEN)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashInviteToken(TOKEN)).not.toContain(TOKEN);
  });

  it('matches only the exact token, in constant shape', () => {
    const h = hashInviteToken(TOKEN);
    expect(inviteHashMatches(h, TOKEN)).toBe(true);
    expect(inviteHashMatches(h, `${TOKEN}x`)).toBe(false);
    expect(inviteHashMatches(h, 'abc')).toBe(false);
    expect(inviteHashMatches(null, TOKEN)).toBe(false);
    expect(inviteHashMatches('short', TOKEN)).toBe(false);
    expect(inviteHashMatches(h, '')).toBe(false);
  });

  it('inviteExpired treats null expiry as never-expiring and past as expired', () => {
    expect(inviteExpired(inviteRow({ invite_expires_at: null }))).toBe(false);
    expect(inviteExpired(inviteRow({ invite_expires_at: new Date(Date.now() - 1000).toISOString() }))).toBe(true);
    expect(inviteExpired(inviteRow())).toBe(false);
  });
});

describe('GET /v1/invites/:token (public invite info)', () => {
  it('returns workspace/inviter/role/expiry without leaking emails or the roster', async () => {
    oneMock.mockResolvedValue(inviteRow());
    const res = await request(app()).get(`/v1/invites/${TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.invite).toMatchObject({ workspace_name: 'Acme Workspace', inviter_name: 'Olivia Owner', role: 'editor', status: 'invited' });
    expect(JSON.stringify(res.body)).not.toContain('invitee@acme.test');
    expect(JSON.stringify(res.body)).not.toContain('owner@acme.test');
    // The lookup key is the hash — the plaintext token never reaches the DB layer.
    const [sql, params] = oneMock.mock.calls[0] as any[];
    expect(sql).toContain('invite_token_hash = $1');
    expect(params).toEqual([hashInviteToken(TOKEN)]);
    expect(params).not.toContain(TOKEN);
  });

  it('answers the same generic 404 for unknown, expired, and already-redeemed tokens', async () => {
    oneMock.mockResolvedValue(undefined);
    const unknown = await request(app()).get('/v1/invites/nope');
    expect(unknown.status).toBe(404);
    expect(unknown.body).toEqual(GENERIC_404);

    oneMock.mockResolvedValue(inviteRow({ invite_expires_at: new Date(Date.now() - 1000).toISOString() }));
    const expired = await request(app()).get(`/v1/invites/${TOKEN}`);
    expect(expired.status).toBe(404);
    expect(expired.body).toEqual(GENERIC_404);

    oneMock.mockResolvedValue(inviteRow({ status: 'active', invite_token_hash: null }));
    // Redeemed rows have their hash cleared, so the DB lookup itself misses;
    // simulate that end state directly.
    oneMock.mockResolvedValue(undefined);
    const redeemed = await request(app()).get(`/v1/invites/${TOKEN}`);
    expect(redeemed.status).toBe(404);
    expect(redeemed.body).toEqual(GENERIC_404);
  });
});

describe('POST /v1/invites/:token/redeem', () => {
  it('activates the membership, burns the token, and returns the workspace', async () => {
    oneMock.mockResolvedValue(inviteRow());
    const res = await request(app()).post(`/v1/invites/${TOKEN}/redeem`).send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ customer_id: 'c1', workspace_name: 'Acme Workspace', role: 'editor' });
    const [sql, params] = execMock.mock.calls[0] as any[];
    expect(sql).toContain("SET status = 'active'");
    expect(sql).toContain('invite_token_hash = NULL');
    expect(sql).toContain("status = 'invited'");
    expect(params).toEqual(['m1', 'u-inv']);
  });

  it('403s when the signed-in email is not the invited email, naming both', async () => {
    testAuth = { ...inviteeAuth, userId: 'u-other', email: 'other@acme.test' };
    oneMock.mockResolvedValue(inviteRow());
    const res = await request(app()).post(`/v1/invites/${TOKEN}/redeem`).send({});
    expect(res.status).toBe(403);
    expect(res.body.error).toContain('other@acme.test');
    expect(res.body.error).toContain('invitee@acme.test');
    expect(execMock).not.toHaveBeenCalled();
  });

  it('matches the invited email case-insensitively', async () => {
    testAuth = { ...inviteeAuth, email: 'Invitee@ACME.test' };
    oneMock.mockResolvedValue(inviteRow());
    const res = await request(app()).post(`/v1/invites/${TOKEN}/redeem`).send({});
    expect(res.status).toBe(200);
  });

  it('answers the generic 404 for unknown and expired tokens', async () => {
    oneMock.mockResolvedValue(undefined);
    const unknown = await request(app()).post('/v1/invites/nope/redeem').send({});
    expect(unknown.status).toBe(404);
    expect(unknown.body).toEqual(GENERIC_404);

    oneMock.mockResolvedValue(inviteRow({ invite_expires_at: new Date(Date.now() - 1000).toISOString() }));
    const expired = await request(app()).post(`/v1/invites/${TOKEN}/redeem`).send({});
    expect(expired.status).toBe(404);
    expect(expired.body).toEqual(GENERIC_404);
    expect(execMock).not.toHaveBeenCalled();
  });

  it('treats a replay (row no longer invited at UPDATE time) as the same generic 404', async () => {
    oneMock.mockResolvedValue(inviteRow());
    execMock.mockResolvedValue(0);
    const res = await request(app()).post(`/v1/invites/${TOKEN}/redeem`).send({});
    expect(res.status).toBe(404);
    expect(res.body).toEqual(GENERIC_404);
  });
});
