// AB-05: credential_mode enforcement on the data plane.
// A frozen tool snapshot that requires a credential must refuse the invoke
// with a clear CREDENTIAL_REQUIRED error — the upstream is never called
// unauthenticated, and the refusal is a policy block, not a 500.
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

import { one, exec, audit } from './db.js';
import { invoke, resetUpstreamBreakers } from './runtime.js';

const oneMock = vi.mocked(one);
const execMock = vi.mocked(exec);
const auditMock = vi.mocked(audit);

const VERSION = '1.0.0';
const BUNDLE = 'bundle-abc';
const signature = createHmac('sha256', 'dev-only-signing-secret')
  .update(`${VERSION}:${BUNDLE}`).digest('hex');

function mockReleaseAndTool(credential_mode: string | undefined) {
  oneMock
    .mockResolvedValueOnce({ id: 'r1', project_id: 'p1', version: VERSION, status: 'approved', bundle_hash: BUNDLE, signature })
    .mockResolvedValueOnce({
      tool_snapshot: {
        name: 'getThing',
        credential_mode,
        upstream: { base_url: 'https://api.example.com', path_template: '/thing', param_bindings: [] },
        recovery_rules: [],
      },
    });
}

const req = { project_id: 'p1', version: VERSION, tool_name: 'getThing', args: {} };

beforeEach(() => {
  vi.clearAllMocks();
  resetUpstreamBreakers();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('invoke credential gate (AB-05)', () => {
  it('refuses an oauth tool with a clear connect-account error and never calls the upstream', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    mockReleaseAndTool('oauth');
    const res = await invoke(req);

    expect(res.ok).toBe(false);
    expect(res.error?.condition).toBe('CREDENTIAL_REQUIRED');
    expect(res.error?.message).toMatch(/no account is connected/);
    expect(res.error?.message).toMatch(/Connect an account/);
    expect(fetchMock).not.toHaveBeenCalled();
    // Audited + telemetered as a policy block, not an upstream failure.
    expect(auditMock).toHaveBeenCalledWith('p1', 'runtime.invoke.credential_required', 'tool', undefined,
      expect.objectContaining({ credential_mode: 'oauth' }));
    const telemetry = execMock.mock.calls.find((c) => String(c[0]).includes('INSERT INTO telemetry_events'))!;
    expect(telemetry[1]).toContain('policy_blocked');
  });

  it('refuses an api_key tool naming the missing credential', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    mockReleaseAndTool('api_key');
    const res = await invoke(req);

    expect(res.ok).toBe(false);
    expect(res.error?.condition).toBe('CREDENTIAL_REQUIRED');
    expect(res.error?.message).toMatch(/requires an API key/);
    expect(res.error?.message).toMatch(/Add a credential/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('lets credential_mode = none tools through to the upstream', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ status: 200, text: async () => '{"ok":true}' });
    vi.stubGlobal('fetch', fetchMock);

    mockReleaseAndTool('none');
    const res = await invoke(req);

    expect(res.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('treats a legacy snapshot with no credential_mode as none', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ status: 200, text: async () => '{"ok":true}' });
    vi.stubGlobal('fetch', fetchMock);

    mockReleaseAndTool(undefined);
    const res = await invoke(req);

    expect(res.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
