// DP-07 data-plane auth: POST /v1/runtime/invoke with a gateway key.
// Real runtimeRouter + real rate limiter; DB, JWT auth, and invoke() are
// mocked. Asserts: both key headers work, bad/expired/revoked → 401,
// another project's key → 404, suspended customer → 403, telemetry actor
// carries the prefix (never the secret), and the human path is unchanged.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../db.js', () => ({
  one: vi.fn(),
  q: vi.fn(),
  exec: vi.fn(),
  J: { parse: (v: any, fb: any) => (v == null ? fb : typeof v === 'string' ? JSON.parse(v) : v) },
}));
vi.mock('../eval.js', () => ({ getRun: vi.fn() }));
vi.mock('../release.js', () => ({
  createRelease: vi.fn(), approveRelease: vi.fn(), getManifest: vi.fn(),
  rollbackRelease: vi.fn(), promoteRelease: vi.fn(), promotionReadiness: vi.fn(),
}));
vi.mock('../runtime.js', () => ({ invoke: vi.fn(), telemetrySummary: vi.fn() }));
vi.mock('../auth.js', () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
  requireProjectRole: () => (_req: any, _res: any, next: any) => next(),
  requireProjectRead: () => (_req: any, _res: any, next: any) => next(),
}));

import { one, exec } from '../db.js';
import { invoke } from '../runtime.js';
import { resetInvokeRateLimiter } from '../rate-limit.js';
import { runtimeRouter } from './workflow.js';
import { generateGatewayKeySecret, gatewayKeyPrefix, hashGatewayKey } from '../gateway-keys.js';

const oneMock = vi.mocked(one);
const execMock = vi.mocked(exec);
const invokeMock = vi.mocked(invoke);

const SECRET = generateGatewayKeySecret();

function keyRow(over: any = {}) {
  return {
    id: 'k1', project_id: 'p1', label: 'ci', key_prefix: gatewayKeyPrefix(SECRET),
    key_hash: hashGatewayKey(SECRET), status: 'active', expires_at: null,
    customer_status: 'active', ...over,
  };
}

function app() {
  const a = express();
  a.use(express.json());
  a.use((req: any, _res, next) => { req.auth = { userId: 'u1', memberships: [] }; req.id = 'test-req'; next(); });
  a.use('/v1/runtime', runtimeRouter);
  a.use((err: any, _req: any, res: any, _next: any) => {
    res.status(err?.status ?? 500).json({ error: err?.publicMessage ?? err?.message ?? 'error', code: err?.code ?? 'internal_error', request_id: 'test-req' });
  });
  return a;
}

const body = { project_id: 'p1', version: '1.0.0', tool_name: 'getForecast', args: {} };

beforeEach(() => {
  vi.clearAllMocks();
  resetInvokeRateLimiter();
  execMock.mockResolvedValue(1);
  oneMock.mockResolvedValue(keyRow());
  invokeMock.mockResolvedValue({ ok: true, tool: 'getForecast', release_version: '1.0.0', result: {}, latency_ms: 1 });
});

describe('gateway-key invoke', () => {
  it('accepts Authorization: Bearer and records the prefix actor', async () => {
    const res = await request(app()).post('/v1/runtime/invoke')
      .set('Authorization', `Bearer ${SECRET}`).send(body);
    expect(res.status).toBe(200);
    expect(invokeMock).toHaveBeenCalledWith(expect.objectContaining({
      project_id: 'p1', actor: `api-key:${gatewayKeyPrefix(SECRET)}`,
    }));
    // The full secret never reaches invoke() or the last-used stamp SQL params.
    expect(JSON.stringify(invokeMock.mock.calls)).not.toContain(SECRET);
  });

  it('accepts X-API-Key and fills project_id from the key when omitted', async () => {
    const res = await request(app()).post('/v1/runtime/invoke')
      .set('X-API-Key', SECRET).send({ version: '1.0.0', tool_name: 'getForecast' });
    expect(res.status).toBe(200);
    expect(invokeMock).toHaveBeenCalledWith(expect.objectContaining({ project_id: 'p1' }));
  });

  it('401s unknown, revoked, and expired keys without invoking', async () => {
    oneMock.mockResolvedValue(undefined);
    const unknown = await request(app()).post('/v1/runtime/invoke')
      .set('Authorization', `Bearer ${generateGatewayKeySecret()}`).send(body);
    expect(unknown.status).toBe(401);
    expect(unknown.body.code).toBe('invalid_api_key');

    oneMock.mockResolvedValue(keyRow({ status: 'revoked' }));
    const revoked = await request(app()).post('/v1/runtime/invoke')
      .set('Authorization', `Bearer ${SECRET}`).send(body);
    expect(revoked.status).toBe(401);

    oneMock.mockResolvedValue(keyRow({ expires_at: '2020-01-01T00:00:00.000Z' }));
    const expired = await request(app()).post('/v1/runtime/invoke')
      .set('X-API-Key', SECRET).send(body);
    expect(expired.status).toBe(401);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('404s when the key is presented for another project', async () => {
    const res = await request(app()).post('/v1/runtime/invoke')
      .set('Authorization', `Bearer ${SECRET}`).send({ ...body, project_id: 'p-other' });
    expect(res.status).toBe(404);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('403s when the owning customer cannot write', async () => {
    oneMock.mockResolvedValue(keyRow({ customer_status: 'suspended' }));
    const res = await request(app()).post('/v1/runtime/invoke')
      .set('Authorization', `Bearer ${SECRET}`).send(body);
    expect(res.status).toBe(403);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('human path (no key) still flows through the role gate to invoke', async () => {
    const res = await request(app()).post('/v1/runtime/invoke').send(body);
    expect(res.status).toBe(200);
    expect(invokeMock).toHaveBeenCalledWith(expect.objectContaining({ project_id: 'p1', actor: undefined }));
    // No key lookup happened for a human request.
    expect(oneMock).not.toHaveBeenCalled();
  });
});
