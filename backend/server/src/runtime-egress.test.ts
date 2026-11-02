// SE-08: invoke refuses a private/loopback upstream target via the
// egress policy, without calling fetch and without tripping the
// upstream circuit breaker (a policy block is not a health signal).
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
import { invoke, resetUpstreamBreakers, breakerFor } from './runtime.js';

const oneMock = vi.mocked(one);
const auditMock = vi.mocked(audit);

const VERSION = '1.0.0';
const BUNDLE = 'bundle-abc';
const signature = createHmac('sha256', 'dev-only-signing-secret')
  .update(`${VERSION}:${BUNDLE}`).digest('hex');

function mockToolAt(baseUrl: string) {
  oneMock
    .mockResolvedValueOnce({ id: 'r1', project_id: 'p1', version: VERSION, status: 'approved', bundle_hash: BUNDLE, signature })
    .mockResolvedValueOnce({
      tool_snapshot: {
        name: 'getThing',
        credential_mode: 'none',
        upstream: { base_url: baseUrl, path_template: '/thing', param_bindings: [] },
        recovery_rules: [],
      },
    });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  resetUpstreamBreakers();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('invoke egress gate (SE-08)', () => {
  it('refuses a cloud-metadata target with EGRESS_BLOCKED, no fetch, no breaker trip', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    mockToolAt('http://169.254.169.254');

    const res = await invoke({ project_id: 'p1', version: VERSION, tool_name: 'getThing', args: {} });

    expect(res.ok).toBe(false);
    expect(res.error?.condition).toBe('EGRESS_BLOCKED');
    expect(res.error?.message).toMatch(/Egress blocked/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(auditMock).toHaveBeenCalledWith('p1', 'runtime.invoke.egress_blocked', 'tool', undefined,
      expect.objectContaining({ reason: 'private_address' }));
    expect(breakerFor('http://169.254.169.254').snapshot().state).toBe('closed');
  });

  it('refuses a non-http(s) scheme the same way', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    mockToolAt('file:///etc');

    const res = await invoke({ project_id: 'p1', version: VERSION, tool_name: 'getThing', args: {} });

    expect(res.error?.condition).toBe('EGRESS_BLOCKED');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
