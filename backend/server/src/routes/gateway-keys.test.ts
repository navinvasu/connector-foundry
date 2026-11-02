// DP-07 control API: supertest over the gateway-keys router with a mocked
// DB and the REAL auth middleware (injected req.auth). Asserts the
// security contract: secret shown once at mint, metadata-only lists,
// hash-only persistence, soft revoke, role gates (viewers read-only).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

let uidN = 0;
vi.mock('../db.js', () => ({
  one: vi.fn(),
  q: vi.fn(),
  exec: vi.fn(),
  withTx: vi.fn(),
  J: {
    parse: (v: any, fb: any) =>
      v == null ? fb : typeof v === 'string' ? JSON.parse(v) : v,
  },
  jb: (v: unknown) => JSON.stringify(v),
  uid: () => `key-${++uidN}`,
  audit: vi.fn(),
}));

import { one, q, exec, audit } from '../db.js';
import { gatewayKeysRouter } from './gateway-keys.js';

const oneMock = vi.mocked(one);
const qMock = vi.mocked(q);
const execMock = vi.mocked(exec);
const auditMock = vi.mocked(audit);

const ownerMembership = {
  customerId: 'c1', customerName: 'Demo', customerStatus: 'active', planId: 'starter',
  planName: 'Starter', seatCap: 3, projectCap: 5, telemetryRetentionDays: 90,
  trialEndsAt: null, pastDueSince: null, role: 'owner', membershipStatus: 'active',
};
const ownerAuth = {
  userId: 'u1', email: 'dev@x.test', fullName: 'Dev', isPlatformAdmin: false,
  memberships: [ownerMembership],
};
const viewerAuth = {
  userId: 'u2', email: 'view@x.test', fullName: 'Vic', isPlatformAdmin: false,
  memberships: [{ ...ownerMembership, role: 'viewer' }],
};

function app(auth: any = ownerAuth) {
  const a = express();
  a.use(express.json());
  a.use((req: any, _res, next) => { req.auth = auth; next(); });
  a.use('/v1/projects', gatewayKeysRouter);
  a.use((err: any, _req: any, res: any, _next: any) => {
    const status = err?.status ?? 500;
    res.status(status).json({
      error: err?.publicMessage ?? err?.message ?? 'error',
      code: err?.code ?? 'internal_error',
      request_id: 'test',
    });
  });
  return a;
}

function metaRow(over: any = {}) {
  return {
    id: 'key-1', project_id: 'p1', label: 'ci', key_prefix: 'cf_live_abcd1234',
    status: 'active', created_by: 'u1', created_at: '2026-10-04T00:00:00.000Z',
    expires_at: null, revoked_at: null, last_used_at: null, ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  uidN = 0;
  // requireProjectRole / requireProjectRead resolve the project first.
  oneMock.mockResolvedValue({ id: 'p1', customer_id: 'c1' });
  qMock.mockResolvedValue([]);
  execMock.mockResolvedValue(1);
});

describe('POST /v1/projects/:id/api-keys', () => {
  it('mints a key: 201 with the secret shown once, hash-only persistence', async () => {
    oneMock
      .mockResolvedValueOnce({ id: 'p1', customer_id: 'c1' }) // role gate project
      .mockResolvedValueOnce(metaRow());                      // final metadata select
    const res = await request(app()).post('/v1/projects/p1/api-keys').send({ label: 'ci' });
    expect(res.status).toBe(201);
    expect(res.body.secret).toMatch(/^cf_live_[A-Za-z0-9_-]{20,}$/);
    expect(res.body).not.toHaveProperty('key_hash');
    // The INSERT carries prefix + sha256 hash, never the raw secret column.
    const insert = execMock.mock.calls.find((c) => String(c[0]).includes('INSERT INTO project_api_keys'))!;
    expect(String(insert[0])).toContain('key_prefix, key_hash');
    expect(insert[1]).not.toContain(res.body.secret);
    // The stored prefix is exactly the secret's display head.
    expect((insert[1] as any[])[3]).toBe(res.body.secret.slice(0, 16));
    expect((insert[1] as any[])[4]).toMatch(/^[0-9a-f]{64}$/);
    // Audit metadata carries prefix only.
    const auditMeta = JSON.stringify(auditMock.mock.calls);
    expect(auditMeta).not.toContain(res.body.secret);
  });

  it('400s a past expiry and a missing label', async () => {
    const past = await request(app()).post('/v1/projects/p1/api-keys')
      .send({ label: 'x', expires_at: '2020-01-01T00:00:00.000Z' });
    expect(past.status).toBe(400);
    const noLabel = await request(app()).post('/v1/projects/p1/api-keys').send({});
    expect(noLabel.status).toBe(400);
    expect(noLabel.body.code).toBe('invalid_request');
  });

  it('viewers cannot mint (403 from the real role gate)', async () => {
    const res = await request(app(viewerAuth)).post('/v1/projects/p1/api-keys').send({ label: 'ci' });
    expect(res.status).toBe(403);
    expect(execMock).not.toHaveBeenCalled();
  });
});

describe('GET /v1/projects/:id/api-keys', () => {
  it('lists metadata only, with the caller role for UI gating', async () => {
    qMock.mockResolvedValue([metaRow(), metaRow({ id: 'key-2', status: 'revoked', revoked_at: '2026-10-04T01:00:00.000Z' })]);
    const res = await request(app(viewerAuth)).get('/v1/projects/p1/api-keys');
    expect(res.status).toBe(200);
    expect(res.body.api_keys).toHaveLength(2);
    expect(res.body.api_keys[0]).not.toHaveProperty('key_hash');
    expect(res.body.api_keys[0]).not.toHaveProperty('secret');
    expect(res.body.caller_role).toBe('viewer');
  });
});

describe('POST /v1/projects/:id/api-keys/:keyId/revoke', () => {
  it('soft-revokes: status flip + audit, idempotent on repeat', async () => {
    oneMock
      .mockResolvedValueOnce({ id: 'p1', customer_id: 'c1' }) // role gate
      .mockResolvedValueOnce(metaRow({ key_hash: 'h'.repeat(64) })); // key row
    const res = await request(app()).post('/v1/projects/p1/api-keys/key-1/revoke').send({});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, status: 'revoked' });
    const update = execMock.mock.calls.find((c) => String(c[0]).includes("status = 'revoked'"))!;
    expect(update).toBeTruthy();
    // Repeat: already revoked → no-op success, no second UPDATE.
    oneMock
      .mockResolvedValueOnce({ id: 'p1', customer_id: 'c1' })
      .mockResolvedValueOnce(metaRow({ status: 'revoked', key_hash: 'h'.repeat(64) }));
    execMock.mockClear();
    const again = await request(app()).post('/v1/projects/p1/api-keys/key-1/revoke').send({});
    expect(again.status).toBe(200);
    expect(execMock.mock.calls.some((c) => String(c[0]).includes('UPDATE project_api_keys'))).toBe(false);
  });

  it('404s an unknown key and 403s viewers', async () => {
    oneMock
      .mockResolvedValueOnce({ id: 'p1', customer_id: 'c1' })
      .mockResolvedValueOnce(undefined);
    const missing = await request(app()).post('/v1/projects/p1/api-keys/nope/revoke').send({});
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('gateway_key_not_found');
    const viewer = await request(app(viewerAuth)).post('/v1/projects/p1/api-keys/key-1/revoke').send({});
    expect(viewer.status).toBe(403);
  });
});
