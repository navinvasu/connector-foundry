// AB-02 credential routes: supertest over the router with a mocked DB and
// a real dev-KEK vault (fixture key only). Asserts the security contract:
// 503 until configured, metadata-only responses, cleartext never persisted
// outside the vault, atomic rotate, revocation tombstones, tenancy gates.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
  uid: () => `cred-${++uidN}`,
  audit: vi.fn(),
}));

import { one, q, exec, audit } from '../db.js';
import { credentialsRouter } from './credentials.js';
import { DESTROYED_HANDLE, VaultClient, DevKekProvider } from '../broker/index.js';

const DEV_KEY = '0123456789abcdef'.repeat(4);
const SECRET = 'sk-test-secret-material';

const oneMock = vi.mocked(one);
const qMock = vi.mocked(q);
const execMock = vi.mocked(exec);
const auditMock = vi.mocked(audit);

const ownerMembership = {
  customerId: 'c1', customerName: 'Demo', customerStatus: 'active', planId: 'starter',
  planName: 'Starter', seatCap: 3, projectCap: 5, telemetryRetentionDays: 90,
  trialEndsAt: null, pastDueSince: null, role: 'owner', membershipStatus: 'active',
};
const viewerAuth = {
  userId: 'u1', email: 'dev@x.test', fullName: 'Dev', isPlatformAdmin: false,
  memberships: [{ ...ownerMembership, role: 'viewer' }],
};
const ownerAuth = {
  userId: 'u1', email: 'dev@x.test', fullName: 'Dev', isPlatformAdmin: false,
  memberships: [ownerMembership],
};

function app(auth: any = ownerAuth) {
  const a = express();
  a.use(express.json());
  a.use((req: any, _res, next) => { req.auth = auth; next(); });
  a.use('/v1/projects', credentialsRouter);
  // Terminal error handler mirroring the BE-05 envelope for HttpErrors.
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

function projectRow(customerId = 'c1') {
  return { id: 'p1', customer_id: customerId };
}

async function realHandle(secret: string): Promise<string> {
  return (await new VaultClient(new DevKekProvider(DEV_KEY)).put(secret)).handle;
}

function metaRow(over: any = {}) {
  return {
    id: 'cred-1', project_id: 'p1', label: 'prod key', kind: 'api_key',
    key_fingerprint: 'f'.repeat(64), status: 'active', created_by: 'u1',
    created_at: '2026-10-01T00:00:00.000Z', rotated_at: null, revoked_at: null,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  uidN = 0;
  vi.stubEnv('CF_BROKER_DEV_KEY', DEV_KEY);
  oneMock.mockResolvedValue(undefined);
  qMock.mockResolvedValue([]);
  execMock.mockResolvedValue(1);
});

afterEach(() => { vi.unstubAllEnvs(); });

describe('POST /v1/projects/:id/credentials', () => {
  it('503s credential_storage_not_configured when no vault is configured', async () => {
    vi.stubEnv('CF_BROKER_DEV_KEY', '');
    vi.stubEnv('CF_BROKER_KMS_KEY_ID', '');
    oneMock.mockResolvedValueOnce(projectRow());
    const res = await request(app()).post('/v1/projects/p1/credentials').send({ label: 'k', value: SECRET });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('credential_storage_not_configured');
    expect(execMock).not.toHaveBeenCalled();
  });

  it('captures a key: 201 with metadata only, cleartext never persisted outside the vault', async () => {
    oneMock
      .mockResolvedValueOnce(projectRow())   // requireProjectRole
      .mockResolvedValueOnce(undefined)      // no active credential
      .mockResolvedValueOnce(metaRow());     // final metadata select
    const res = await request(app()).post('/v1/projects/p1/credentials').send({ label: 'prod key', value: SECRET });
    expect(res.status).toBe(201);
    // Metadata only — never the value, never the handle.
    expect(res.body).toMatchObject({ id: 'cred-1', label: 'prod key', kind: 'api_key', status: 'active' });
    expect(res.body.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(res.body).not.toHaveProperty('value');
    expect(res.body).not.toHaveProperty('vault_handle');
    // The INSERT carries the envelope, not the cleartext.
    const insert = execMock.mock.calls.find((c) => String(c[0]).includes('INSERT INTO project_credentials'))!;
    expect(JSON.stringify(insert[1])).not.toContain(SECRET);
    expect(String(insert[1]![3])).toMatch(/^cfv1\./);
    // Audit metadata carries label + fingerprint, never the value.
    expect(auditMock).toHaveBeenCalledWith('p1', 'credential.captured', 'credential', 'cred-1',
      expect.objectContaining({ label: 'prod key', fingerprint: expect.any(String) }));
    expect(JSON.stringify(auditMock.mock.calls[0][4])).not.toContain(SECRET);
  });

  it('400s when the value is missing', async () => {
    oneMock.mockResolvedValueOnce(projectRow());
    const res = await request(app()).post('/v1/projects/p1/credentials').send({ label: 'k' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_request');
    expect(execMock).not.toHaveBeenCalled();
  });

  it('409s when an active credential already exists', async () => {
    oneMock
      .mockResolvedValueOnce(projectRow())
      .mockResolvedValueOnce({ id: 'cred-0' });
    const res = await request(app()).post('/v1/projects/p1/credentials').send({ label: 'k2', value: SECRET });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('credential_already_configured');
  });

  it('409s on a lost capture race (unique-violation backstop)', async () => {
    oneMock
      .mockResolvedValueOnce(projectRow())
      .mockResolvedValueOnce(undefined);
    execMock.mockRejectedValueOnce(Object.assign(new Error('duplicate key'), { code: '23505' }));
    const res = await request(app()).post('/v1/projects/p1/credentials').send({ label: 'k2', value: SECRET });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('credential_already_configured');
  });

  it('403s for viewers', async () => {
    oneMock.mockResolvedValueOnce(projectRow());
    const res = await request(app(viewerAuth)).post('/v1/projects/p1/credentials').send({ label: 'k', value: SECRET });
    expect(res.status).toBe(403);
  });
});

describe('GET /v1/projects/:id/credentials', () => {
  it('lists metadata without vault handles', async () => {
    oneMock.mockResolvedValueOnce(projectRow());
    qMock.mockResolvedValueOnce([{ ...metaRow(), vault_handle: 'cfv1.envelope-bytes' }]);
    const res = await request(app()).get('/v1/projects/p1/credentials');
    expect(res.status).toBe(200);
    expect(res.body.credentials).toHaveLength(1);
    expect(res.body.credentials[0]).not.toHaveProperty('vault_handle');
    expect(res.body.credentials[0]).not.toHaveProperty('value');
    expect(res.body.credentials[0].fingerprint).toBe('f'.repeat(64));
  });

  it('404s for outsiders (no existence leak)', async () => {
    oneMock.mockResolvedValueOnce(projectRow('c2'));
    const res = await request(app()).get('/v1/projects/p1/credentials');
    expect(res.status).toBe(404);
  });
});

describe('POST /v1/projects/:id/credentials/:credId/rotate', () => {
  it('atomically swaps the handle; the old envelope is unreferenced', async () => {
    const oldHandle = await realHandle('old-secret');
    // The route fingerprints the new material itself — the mock row and the
    // assertions must agree with the real sha256.
    const newFingerprint = VaultClient.fingerprint('sk-new-secret');
    oneMock
      .mockResolvedValueOnce(projectRow())
      .mockResolvedValueOnce({ ...metaRow(), vault_handle: oldHandle, key_fingerprint: '0'.repeat(64) })
      .mockResolvedValueOnce(metaRow({ key_fingerprint: newFingerprint, rotated_at: '2026-10-01T01:00:00.000Z' }));
    const res = await request(app()).post('/v1/projects/p1/credentials/cred-1/rotate').send({ value: 'sk-new-secret' });
    expect(res.status).toBe(200);
    expect(res.body.fingerprint).toBe(newFingerprint);
    expect(res.body).not.toHaveProperty('vault_handle');
    const update = execMock.mock.calls.find((c) => String(c[0]).includes('UPDATE project_credentials SET vault_handle'))!;
    expect(update[1]![0]).toMatch(/^cfv1\./);
    expect(update[1]![0]).not.toBe(oldHandle);
    expect(JSON.stringify(update[1])).not.toContain('sk-new-secret');
    expect(auditMock).toHaveBeenCalledWith('p1', 'credential.rotated', 'credential', 'cred-1',
      expect.objectContaining({ fingerprint: newFingerprint }));
  });

  it('404s for an unknown or revoked credential', async () => {
    oneMock
      .mockResolvedValueOnce(projectRow())
      .mockResolvedValueOnce({ ...metaRow(), status: 'revoked' });
    const res = await request(app()).post('/v1/projects/p1/credentials/cred-9/rotate').send({ value: 'x' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('credential_not_found');
  });
});

describe('POST /v1/projects/:id/credentials/:credId/revoke', () => {
  it('flips status and crypto-erases the handle in place', async () => {
    oneMock
      .mockResolvedValueOnce(projectRow())
      .mockResolvedValueOnce({ ...metaRow(), vault_handle: await realHandle('live-secret') });
    const res = await request(app()).post('/v1/projects/p1/credentials/cred-1/revoke');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, id: 'cred-1', status: 'revoked' });
    const update = execMock.mock.calls.find((c) => String(c[0]).includes("SET status = 'revoked'"))!;
    expect(update[1]![0]).toBe(DESTROYED_HANDLE);
    expect(auditMock).toHaveBeenCalledWith('p1', 'credential.revoked', 'credential', 'cred-1',
      expect.objectContaining({ fingerprint: 'f'.repeat(64) }));
  });

  it('is idempotent: revoking twice is a no-op success', async () => {
    oneMock
      .mockResolvedValueOnce(projectRow())
      .mockResolvedValueOnce({ ...metaRow(), status: 'revoked' });
    const res = await request(app()).post('/v1/projects/p1/credentials/cred-1/revoke');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('revoked');
    expect(execMock).not.toHaveBeenCalled();
  });

  it('404s for an unknown credential', async () => {
    oneMock
      .mockResolvedValueOnce(projectRow())
      .mockResolvedValueOnce(undefined);
    const res = await request(app()).post('/v1/projects/p1/credentials/nope/revoke');
    expect(res.status).toBe(404);
  });
});
