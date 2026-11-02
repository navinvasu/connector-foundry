// AB-02 lease tests: mocked DB, real dev-KEK envelope (fixture key only).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../db.js', () => ({
  one: vi.fn(),
  q: vi.fn(),
  exec: vi.fn(),
  J: { parse: (v: any, fb: any) => (v == null ? fb : v) },
  jb: (v: unknown) => JSON.stringify(v),
  uid: () => 'uid-1',
  audit: vi.fn(),
}));

import { one } from '../db.js';
import { resolveLease, resolveProjectTenant, DESTROYED_HANDLE } from './leases.js';
import { VaultClient, DevKekProvider } from './vault.js';

const DEV_KEY = '0123456789abcdef'.repeat(4);
const oneMock = vi.mocked(one);

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv('CF_BROKER_DEV_KEY', DEV_KEY);
});

afterEach(() => { vi.unstubAllEnvs(); });

async function realHandle(material = 'sk-test-123'): Promise<string> {
  return (await new VaultClient(new DevKekProvider(DEV_KEY)).put(material)).handle;
}

describe('resolveLease', () => {
  it('decrypts the active credential for the owning tenant', async () => {
    const handle = await realHandle('sk-test-123');
    oneMock.mockResolvedValueOnce({ vault_handle: handle });
    const lease = await resolveLease({ tenant: 'c1', projectId: 'p1', scopes: [], purpose: 'invoke' });
    expect(lease).toEqual({ ok: true, material: 'sk-test-123' });
    // Tenant scoping lives in the SQL join, not in caller trust.
    expect(String(oneMock.mock.calls[0][0])).toContain('p.customer_id = $2');
    expect(oneMock.mock.calls[0][1]).toEqual(['p1', 'c1']);
  });

  it('denies when no active credential exists', async () => {
    oneMock.mockResolvedValueOnce(undefined);
    expect(await resolveLease({ tenant: 'c1', projectId: 'p1', scopes: [], purpose: 'invoke' }))
      .toEqual({ ok: false, reason: 'credential_missing' });
  });

  it('denies a destroyed (revoked) handle even if the row is returned', async () => {
    oneMock.mockResolvedValueOnce({ vault_handle: DESTROYED_HANDLE });
    expect(await resolveLease({ tenant: 'c1', projectId: 'p1', scopes: [], purpose: 'invoke' }))
      .toEqual({ ok: false, reason: 'credential_missing' });
  });

  it('is unresolvable from another tenant\u2019s context (faithful join stub)', async () => {
    const handle = await realHandle('tenant-key');
    // Stub the SQL join semantics: the row exists for (p1, c1) only.
    oneMock.mockImplementation(async (_sql: string, params?: unknown[]) => {
      if (params?.[0] === 'p1' && params?.[1] === 'c1') return { vault_handle: handle };
      return undefined;
    });
    const own = await resolveLease({ tenant: 'c1', projectId: 'p1', scopes: [], purpose: 'invoke' });
    expect(own).toEqual({ ok: true, material: 'tenant-key' });
    const other = await resolveLease({ tenant: 'c2', projectId: 'p1', scopes: [], purpose: 'invoke' });
    expect(other).toEqual({ ok: false, reason: 'credential_missing' });
  });

  it('fails closed on a foreign handle (no material, no leak)', async () => {
    oneMock.mockResolvedValueOnce({ vault_handle: 'cfv1.bogus' });
    await expect(resolveLease({ tenant: 'c1', projectId: 'p1', scopes: [], purpose: 'invoke' }))
      .rejects.toThrow('unrecognized vault handle');
  });

  it('503s when the vault is not configured', async () => {
    vi.stubEnv('CF_BROKER_DEV_KEY', '');
    const handle = await realHandle();
    oneMock.mockResolvedValueOnce({ vault_handle: handle });
    await expect(resolveLease({ tenant: 'c1', projectId: 'p1', scopes: [], purpose: 'invoke' }))
      .rejects.toMatchObject({ status: 503, code: 'credential_storage_not_configured' });
  });
});

describe('resolveProjectTenant', () => {
  it('returns the owning customer id', async () => {
    oneMock.mockResolvedValueOnce({ customer_id: 'c9' });
    expect(await resolveProjectTenant('p1')).toBe('c9');
  });

  it('returns null for unknown projects', async () => {
    oneMock.mockResolvedValueOnce(undefined);
    expect(await resolveProjectTenant('nope')).toBeNull();
  });
});
