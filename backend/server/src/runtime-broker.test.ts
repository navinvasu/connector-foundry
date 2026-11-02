// AB-02 runtime injection: an api_key tool with a broker credential gets
// the key injected per its frozen scheme; without one the AB-05 refusal
// stays byte-identical.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';

vi.mock('./db.js', () => ({
  one: vi.fn(),
  q: vi.fn(),
  exec: vi.fn(),
  J: { parse: (v: any, fb: any) => (v == null ? fb : v) },
  uid: () => 'uid-1',
  audit: vi.fn(),
}));

import { one, audit } from './db.js';
import { invoke, resetUpstreamBreakers } from './runtime.js';
import { VaultClient, DevKekProvider } from './broker/vault.js';

const DEV_KEY = '0123456789abcdef'.repeat(4);
const VERSION = '1.0.0';
const BUNDLE = 'bundle-abc';
const signature = createHmac('sha256', 'dev-only-signing-secret')
  .update(`${VERSION}:${BUNDLE}`).digest('hex');

const oneMock = vi.mocked(one);
const auditMock = vi.mocked(audit);

async function handleFor(key: string): Promise<string> {
  return (await new VaultClient(new DevKekProvider(DEV_KEY)).put(key)).handle;
}

/** Mock the one() call chain: release → tool snapshot → tenant → lease. */
function mockInvokeChain(upstream: any, handle: string | undefined, tenant: any) {
  oneMock
    .mockResolvedValueOnce({ id: 'r1', project_id: 'p1', version: VERSION, status: 'approved', bundle_hash: BUNDLE, signature })
    .mockResolvedValueOnce({
      tool_snapshot: { name: 'getThing', credential_mode: 'api_key', upstream, recovery_rules: [] },
    })
    .mockResolvedValueOnce(tenant)
    .mockResolvedValueOnce(handle ? { vault_handle: handle } : undefined);
}

const req = { project_id: 'p1', version: VERSION, tool_name: 'getThing', args: {} };

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv('CF_BROKER_DEV_KEY', DEV_KEY);
  resetUpstreamBreakers();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('invoke with a broker key (AB-02)', () => {
  it('injects a bearer key into the Authorization header', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: any): Promise<any> => ({ status: 200, text: async () => '{}' }));
    vi.stubGlobal('fetch', fetchMock);
    mockInvokeChain(
      { base_url: 'https://api.example.com', path_template: '/thing', param_bindings: [],
        auth_injection: { location: 'header', name: 'Authorization', scheme: 'bearer' } },
      await handleFor('live-key-abc'), { customer_id: 'c1' });

    const res = await invoke(req);

    expect(res.ok).toBe(true);
    const headers = fetchMock.mock.calls[0][1].headers;
    expect(headers['Authorization']).toBe('Bearer live-key-abc');
    expect(headers['user-agent']).toBe('connector-foundry-runtime/0.1');
  });

  it('injects a query key into the URL', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: any): Promise<any> => ({ status: 200, text: async () => '{}' }));
    vi.stubGlobal('fetch', fetchMock);
    mockInvokeChain(
      { base_url: 'https://api.example.com', path_template: '/thing', param_bindings: [],
        auth_injection: { location: 'query', name: 'api_key' } },
      await handleFor('live-key-abc'), { customer_id: 'c1' });

    await invoke(req);

    expect(fetchMock.mock.calls[0][0]).toContain('api_key=live-key-abc');
    expect(fetchMock.mock.calls[0][1].headers).not.toHaveProperty('Authorization');
  });

  it('falls back to X-API-Key for pre-AB-02 snapshots (D-35)', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: any): Promise<any> => ({ status: 200, text: async () => '{}' }));
    vi.stubGlobal('fetch', fetchMock);
    mockInvokeChain(
      { base_url: 'https://api.example.com', path_template: '/thing', param_bindings: [] },
      await handleFor('live-key-abc'), { customer_id: 'c1' });

    await invoke(req);

    expect(fetchMock.mock.calls[0][1].headers['X-API-Key']).toBe('live-key-abc');
  });

  it('denies when the lease lookup finds nothing for this tenant', async () => {
    const fetchMock: ReturnType<typeof vi.fn> = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    // The lease query joins project_credentials to projects on customer_id:
    // a tenant mismatch returns no row even though the project id is right.
    mockInvokeChain(
      { base_url: 'https://api.example.com', path_template: '/thing', param_bindings: [],
        auth_injection: { location: 'header', name: 'X-API-Key' } },
      undefined, { customer_id: 'WRONG' });

    const res = await invoke(req);

    expect(res.ok).toBe(false);
    expect(res.error?.condition).toBe('CREDENTIAL_REQUIRED');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses byte-identical when no credential is configured', async () => {
    const fetchMock: ReturnType<typeof vi.fn> = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    mockInvokeChain(
      { base_url: 'https://api.example.com', path_template: '/thing', param_bindings: [] },
      undefined, { customer_id: 'c1' });

    const res = await invoke(req);

    expect(res.ok).toBe(false);
    expect(res.error).toEqual({
      condition: 'CREDENTIAL_REQUIRED',
      message: 'Tool "getThing" requires an API key, but no credential is configured for this project. Add a credential and try again.',
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(auditMock).toHaveBeenCalledWith('p1', 'runtime.invoke.credential_required', 'tool', undefined,
      expect.objectContaining({ credential_mode: 'api_key' }));
  });
});
