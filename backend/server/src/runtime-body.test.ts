// BE-16: invoke must deliver the tool's HTTP method and JSON body to the
// upstream — proven against a real local stub HTTP server, so the
// assertion is what arrived on the wire, not what a mock was told.
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

const VERSION = '1.0.0';
const BUNDLE = 'bundle-abc';
const signature = createHmac('sha256', 'dev-only-signing-secret')
  .update(`${VERSION}:${BUNDLE}`).digest('hex');
const oneMock = vi.mocked(one);

interface Seen { method?: string; url?: string; headers: any; body: string }
let server: Server;
let seen: Seen;
let baseUrl: string;

function mockTool(upstream: any) {
  oneMock
    .mockResolvedValueOnce({ id: 'r1', project_id: 'p1', version: VERSION, status: 'approved', bundle_hash: BUNDLE, signature })
    .mockResolvedValueOnce({
      tool_snapshot: { name: 'createWidget', credential_mode: 'none', upstream, recovery_rules: [] },
    });
}

beforeEach(async () => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
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
      res.end(JSON.stringify({ ok: true, echoed: seen.body ? JSON.parse(seen.body) : null }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('invoke request bodies (BE-16)', () => {
  it('POSTs the assembled JSON body with the tool method + query args', async () => {
    mockTool({
      method: 'POST', path_template: '/widgets', base_url: baseUrl,
      param_bindings: [
        { arg: 'verbose', location: 'query', target: 'verbose' },
        { arg: 'name', location: 'body', target: 'name' },
        { arg: 'displayCount', location: 'body', target: 'display_count' },
      ],
    });

    const res = await invoke({
      project_id: 'p1', version: VERSION, tool_name: 'createWidget',
      args: { verbose: 'true', name: 'gear', displayCount: 3 },
    });

    expect(res.ok).toBe(true);
    expect(seen.method).toBe('POST');
    expect(seen.url).toBe('/widgets?verbose=true');
    expect(seen.headers['content-type']).toContain('application/json');
    expect(JSON.parse(seen.body)).toEqual({ name: 'gear', display_count: 3 });
    expect((res.result as any).echoed).toEqual({ name: 'gear', display_count: 3 });
  });

  it('PUTs a whole-body arg verbatim', async () => {
    mockTool({
      method: 'PUT', path_template: '/widgets/1', base_url: baseUrl,
      param_bindings: [{ arg: 'body', location: 'body', target: '' }],
    });

    const res = await invoke({
      project_id: 'p1', version: VERSION, tool_name: 'createWidget',
      args: { body: { anything: [1, 2] } },
    });

    expect(res.ok).toBe(true);
    expect(seen.method).toBe('PUT');
    expect(JSON.parse(seen.body)).toEqual({ anything: [1, 2] });
  });

  it('GET tools keep sending GET with no body and no content-type', async () => {
    mockTool({
      method: 'GET', path_template: '/widgets', base_url: baseUrl,
      param_bindings: [{ arg: 'limit', location: 'query', target: 'limit' }],
    });

    const res = await invoke({
      project_id: 'p1', version: VERSION, tool_name: 'createWidget',
      args: { limit: 5 },
    });

    expect(res.ok).toBe(true);
    expect(seen.method).toBe('GET');
    expect(seen.url).toBe('/widgets?limit=5');
    expect(seen.body).toBe('');
    expect(seen.headers['content-type']).toBeUndefined();
  });

  it('sends no body when every body arg is omitted (upstream still gets the method)', async () => {
    mockTool({
      method: 'POST', path_template: '/widgets', base_url: baseUrl,
      param_bindings: [{ arg: 'name', location: 'body', target: 'name' }],
    });

    const res = await invoke({
      project_id: 'p1', version: VERSION, tool_name: 'createWidget', args: {},
    });

    expect(res.ok).toBe(true);
    expect(seen.method).toBe('POST');
    expect(seen.body).toBe('');
  });
});
