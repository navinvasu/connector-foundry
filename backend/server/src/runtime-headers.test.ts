// BE-17: header/cookie params must reach the upstream — proven against a
// real local stub HTTP server, so the assertion is what arrived on the
// wire (including the BE-17 precedence rule: an injected broker credential
// beats a caller-supplied header/cookie of the same name).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createHmac } from 'node:crypto';

vi.mock('./db.js', () => ({
  one: vi.fn(),
  q: vi.fn(),
  exec: vi.fn(),
  J: { parse: (v: any, fb: any) => (v == null ? fb : v) },
  uid: () => 'uid-1',
  audit: vi.fn(),
}));

import { one } from './db.js';
import { invoke, resetUpstreamBreakers } from './runtime.js';
import { VaultClient, DevKekProvider } from './broker/vault.js';

const DEV_KEY = '0123456789abcdef'.repeat(4);
const VERSION = '1.0.0';
const BUNDLE = 'bundle-abc';
const signature = createHmac('sha256', 'dev-only-signing-secret')
  .update(`${VERSION}:${BUNDLE}`).digest('hex');
const oneMock = vi.mocked(one);

interface Seen { method?: string; url?: string; headers: any; body: string }
let server: Server;
let seen: Seen;
let baseUrl: string;

function mockTool(upstream: any, credentialMode = 'none') {
  oneMock
    .mockResolvedValueOnce({ id: 'r1', project_id: 'p1', version: VERSION, status: 'approved', bundle_hash: BUNDLE, signature })
    .mockResolvedValueOnce({
      tool_snapshot: { name: 'getWidget', credential_mode: credentialMode, upstream, recovery_rules: [] },
    });
}

async function mockBrokerTool(upstream: any) {
  const handle = (await new VaultClient(new DevKekProvider(DEV_KEY)).put('live-key-abc')).handle;
  mockTool(upstream, 'api_key');
  oneMock
    .mockResolvedValueOnce({ customer_id: 'c1' })
    .mockResolvedValueOnce({ vault_handle: handle });
}

beforeEach(async () => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv('CF_BROKER_DEV_KEY', DEV_KEY);
  // SE-08: the stub upstream lives on 127.0.0.1, which the egress policy
  // refuses by default — opt in explicitly for this wire-level suite.
  vi.stubEnv('CF_EGRESS_ALLOW_PRIVATE', 'true');
  resetUpstreamBreakers();
  seen = { headers: {}, body: '' };
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      seen = {
        method: req.method, url: req.url, headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('invoke header/cookie params (BE-17)', () => {
  it('sends header params and merges cookie params into one Cookie header', async () => {
    mockTool({
      method: 'GET', path_template: '/widgets', base_url: baseUrl,
      param_bindings: [
        { arg: 'tenant', location: 'header', target: 'X-Tenant' },
        { arg: 'session', location: 'cookie', target: 'session' },
        { arg: 'prefs', location: 'cookie', target: 'prefs' },
      ],
    });

    const res = await invoke({
      project_id: 'p1', version: VERSION, tool_name: 'getWidget',
      args: { tenant: 'acme', session: 's1', prefs: 'dark' },
    });

    expect(res.ok).toBe(true);
    expect(seen.headers['x-tenant']).toBe('acme');
    expect(seen.headers.cookie).toBe('session=s1; prefs=dark');
    expect(seen.headers['user-agent']).toBe('connector-foundry-runtime/0.1');
  });

  it('injected bearer credential beats a caller-supplied Authorization header param', async () => {
    await mockBrokerTool({
      method: 'GET', path_template: '/widgets', base_url: baseUrl,
      param_bindings: [{ arg: 'authorization', location: 'header', target: 'Authorization' }],
      auth_injection: { location: 'header', name: 'Authorization', scheme: 'bearer' },
    });

    const res = await invoke({
      project_id: 'p1', version: VERSION, tool_name: 'getWidget',
      args: { authorization: 'caller-supplied' },
    });

    expect(res.ok).toBe(true);
    expect(seen.headers.authorization).toBe('Bearer live-key-abc');
  });

  it('injected cookie credential replaces the same-named caller cookie, keeps the rest', async () => {
    await mockBrokerTool({
      method: 'GET', path_template: '/widgets', base_url: baseUrl,
      param_bindings: [
        { arg: 'sess', location: 'cookie', target: 'sess' },
        { arg: 'prefs', location: 'cookie', target: 'prefs' },
      ],
      auth_injection: { location: 'header', name: 'Cookie', cookieName: 'sess' },
    });

    const res = await invoke({
      project_id: 'p1', version: VERSION, tool_name: 'getWidget',
      args: { sess: 'caller-value', prefs: 'dark' },
    });

    expect(res.ok).toBe(true);
    expect(seen.headers.cookie).toBe('sess=live-key-abc; prefs=dark');
  });
});
