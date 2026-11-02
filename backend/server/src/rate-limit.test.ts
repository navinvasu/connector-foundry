// BE-07: rate limiting on the data plane (POST /v1/runtime/invoke).
// SE-09: the IP bucket charges pre-authorization, the project bucket
// only after the role gate admits the caller.
// Limiter unit tests use an injected clock; middleware tests run through
// supertest; invoke-level tests stub global fetch and the DB layer (same
// mocking pattern as circuit-breaker.test.ts).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import express from 'express';
import request from 'supertest';

vi.mock('./db.js', () => ({
  one: vi.fn(),
  q: vi.fn(),
  exec: vi.fn(),
  J: { parse: (v: any, fb: any) => (v == null ? fb : v) },
  uid: () => 'uid-1',
  audit: vi.fn(),
}));

import { one, exec, audit } from './db.js';
import {
  FixedWindowRateLimiter, checkInvokeRateLimit, checkIpRateLimit, checkProjectRateLimit,
  invokeIpRateLimit, invokeProjectRateLimit, invokeRateLimit,
  resetInvokeRateLimiter,
} from './rate-limit.js';
import { invoke, resetUpstreamBreakers } from './runtime.js';

const oneMock = vi.mocked(one);
const execMock = vi.mocked(exec);
const auditMock = vi.mocked(audit);

const ENV_KEYS = [
  'CF_INVOKE_RATE_LIMIT_PER_PROJECT', 'CF_INVOKE_RATE_LIMIT_PER_IP', 'CF_INVOKE_RATE_WINDOW_MS',
];
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  vi.clearAllMocks();
  resetInvokeRateLimiter();
  resetUpstreamBreakers();
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
  }
});

// ─── FixedWindowRateLimiter ────────────────────────────────────────────────

describe('FixedWindowRateLimiter', () => {
  it('admits up to the limit, then denies with remaining 0 and a reset time', () => {
    const lim = new FixedWindowRateLimiter(() => 1_000);
    expect(lim.check('k', 2, 60_000)).toMatchObject({ allowed: true, remaining: 1, limit: 2 });
    expect(lim.check('k', 2, 60_000)).toMatchObject({ allowed: true, remaining: 0 });
    const denied = lim.check('k', 2, 60_000);
    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(0);
    expect(denied.reset_at).toBe(61_000);
    expect(denied.retry_after_ms).toBe(60_000);
  });

  it('starts a fresh window after the previous one expires', () => {
    let now = 0;
    const lim = new FixedWindowRateLimiter(() => now);
    lim.check('k', 1, 1_000);
    expect(lim.check('k', 1, 1_000).allowed).toBe(false);
    now = 999;
    expect(lim.check('k', 1, 1_000).allowed).toBe(false);
    now = 1_000;
    const d = lim.check('k', 1, 1_000);
    expect(d.allowed).toBe(true);
    expect(d.reset_at).toBe(2_000);
  });

  it('keeps buckets independent per key', () => {
    const lim = new FixedWindowRateLimiter(() => 0);
    lim.check('a', 1, 60_000);
    expect(lim.check('a', 1, 60_000).allowed).toBe(false);
    expect(lim.check('b', 1, 60_000).allowed).toBe(true);
  });

  it('denied hits still count, so retry_after does not shrink while hammering', () => {
    let now = 0;
    const lim = new FixedWindowRateLimiter(() => now);
    lim.check('k', 1, 10_000);
    now = 4_000;
    expect(lim.check('k', 1, 10_000).retry_after_ms).toBe(6_000);
    now = 8_000;
    expect(lim.check('k', 1, 10_000).retry_after_ms).toBe(2_000);
  });
});

// ─── checkInvokeRateLimit: per-project + per-IP ────────────────────────────

describe('checkInvokeRateLimit', () => {
  it('trips the project bucket at the per-project limit; other projects unaffected', () => {
    process.env.CF_INVOKE_RATE_LIMIT_PER_PROJECT = '2';
    process.env.CF_INVOKE_RATE_LIMIT_PER_IP = '100';
    const lim = new FixedWindowRateLimiter();
    expect(checkInvokeRateLimit('p1', '10.0.0.1', lim).allowed).toBe(true);
    expect(checkInvokeRateLimit('p1', '10.0.0.1', lim).allowed).toBe(true);
    const denied = checkInvokeRateLimit('p1', '10.0.0.2', lim); // even from a fresh IP
    expect(denied.allowed).toBe(false);
    expect(denied.bucket).toBe('project');
    expect(checkInvokeRateLimit('p2', '10.0.0.1', lim).allowed).toBe(true);
  });

  it('trips the IP bucket across projects; other IPs unaffected', () => {
    process.env.CF_INVOKE_RATE_LIMIT_PER_PROJECT = '100';
    process.env.CF_INVOKE_RATE_LIMIT_PER_IP = '2';
    const lim = new FixedWindowRateLimiter();
    expect(checkInvokeRateLimit('p1', '10.0.0.9', lim).allowed).toBe(true);
    expect(checkInvokeRateLimit('p2', '10.0.0.9', lim).allowed).toBe(true);
    const denied = checkInvokeRateLimit('p3', '10.0.0.9', lim);
    expect(denied.allowed).toBe(false);
    expect(denied.bucket).toBe('ip');
    expect(checkInvokeRateLimit('p3', '10.0.0.10', lim).allowed).toBe(true);
  });

  it('a project-denied hit does not burn the caller IP bucket', () => {
    process.env.CF_INVOKE_RATE_LIMIT_PER_PROJECT = '1';
    process.env.CF_INVOKE_RATE_LIMIT_PER_IP = '2';
    const lim = new FixedWindowRateLimiter();
    expect(checkInvokeRateLimit('p1', '10.0.0.1', lim).allowed).toBe(true);  // ip count 1
    expect(checkInvokeRateLimit('p1', '10.0.0.1', lim).allowed).toBe(false); // project-denied, ip untouched
    // If the denied hit had charged the IP bucket, this other project would be denied (ip would be 3 > 2).
    expect(checkInvokeRateLimit('p2', '10.0.0.1', lim).allowed).toBe(true);
  });

  it('defaults: 600/project and 1200/IP per 60s when env is unset', () => {
    delete process.env.CF_INVOKE_RATE_LIMIT_PER_PROJECT;
    delete process.env.CF_INVOKE_RATE_LIMIT_PER_IP;
    delete process.env.CF_INVOKE_RATE_WINDOW_MS;
    const lim = new FixedWindowRateLimiter(() => 0);
    const d = checkInvokeRateLimit('p1', '10.0.0.1', lim);
    expect(d.allowed).toBe(true);
    expect(d.limit).toBe(600); // project bucket is tighter, so it is reported
    expect(d.remaining).toBe(599);
  });
});

// ─── SE-09: split bucket checks ────────────────────────────────────────────

describe('checkIpRateLimit / checkProjectRateLimit (SE-09)', () => {
  it('the IP check charges only the IP bucket; project quota is untouched', () => {
    process.env.CF_INVOKE_RATE_LIMIT_PER_PROJECT = '1';
    process.env.CF_INVOKE_RATE_LIMIT_PER_IP = '2';
    const lim = new FixedWindowRateLimiter();
    expect(checkIpRateLimit('10.0.0.1', lim)).toMatchObject({ allowed: true, bucket: 'ip', limit: 2 });
    expect(checkIpRateLimit('10.0.0.1', lim).allowed).toBe(true);
    expect(checkIpRateLimit('10.0.0.1', lim)).toMatchObject({ allowed: false, bucket: 'ip' });
    // The project bucket was never charged by the IP checks above.
    expect(checkProjectRateLimit('p1', lim)).toMatchObject({ allowed: true, bucket: 'project', limit: 1 });
    expect(checkProjectRateLimit('p1', lim).allowed).toBe(false);
    // A different project still has its own quota; a different IP too.
    expect(checkProjectRateLimit('p2', lim).allowed).toBe(true);
    expect(checkIpRateLimit('10.0.0.2', lim).allowed).toBe(true);
  });
});

// ─── SE-09: split middlewares around the role gate ─────────────────────────
//
// The real chain is invokeIpRateLimit → requireProjectRole →
// invokeProjectRateLimit. The apps below stand in for the role gate with
// a stub so the ordering property is testable without a database:
// admitted callers get `req.project` attached; outsiders get a 404 and
// never reach the project middleware.

function baseApp() {
  const a = express();
  a.use(express.json());
  a.use((req: any, _res, next) => { req.id = 'req-test'; next(); });
  return a;
}

/** IP-only chain (pre-authorization half). */
function ipOnlyApp() {
  const a = baseApp();
  a.post('/v1/runtime/invoke', invokeIpRateLimit, (_req, res) => res.json({ ok: true }));
  return a;
}

/**
 * Full SE-09 chain. The stub role gate admits only the `x-test-member`
 * header (attaching the resolved project, like requireProjectRole);
 * everyone else gets the gate's 404.
 */
function orderedApp() {
  const a = baseApp();
  const roleGate = (req: any, res: any, next: any) => {
    if (req.headers['x-test-member'] !== 'yes') {
      return res.status(404).json({ error: 'Project not found' });
    }
    req.project = { id: typeof req.body?.project_id === 'string' ? req.body.project_id : 'p1' };
    return next();
  };
  a.post('/v1/runtime/invoke', invokeIpRateLimit, roleGate, invokeProjectRateLimit,
    (_req, res) => res.json({ ok: true }));
  return a;
}

describe('invokeIpRateLimit middleware (SE-09 pre-auth)', () => {
  it('admits under the IP limit and sets X-RateLimit headers from the IP bucket', async () => {
    process.env.CF_INVOKE_RATE_LIMIT_PER_IP = '5';
    process.env.CF_INVOKE_RATE_LIMIT_PER_PROJECT = '600';
    const res = await request(ipOnlyApp())
      .post('/v1/runtime/invoke')
      .send({ project_id: 'p1', version: '1', tool_name: 't' });
    expect(res.status).toBe(200);
    expect(res.headers['x-ratelimit-limit']).toBe('5');
    expect(res.headers['x-ratelimit-remaining']).toBe('4');
    expect(res.headers['x-ratelimit-reset']).toBeTruthy();
  });

  it('per-IP trip returns bucket ip even when projects rotate', async () => {
    process.env.CF_INVOKE_RATE_LIMIT_PER_PROJECT = '100';
    process.env.CF_INVOKE_RATE_LIMIT_PER_IP = '2';
    const app = ipOnlyApp();
    const send = (pid: string) => request(app).post('/v1/runtime/invoke')
      .send({ project_id: pid, version: '1', tool_name: 't' });
    expect((await send('p1')).status).toBe(200);
    expect((await send('p2')).status).toBe(200);
    const denied = await send('p3');
    expect(denied.status).toBe(429);
    expect(denied.body.code).toBe('rate_limited');
    expect(denied.body.request_id).toBe('req-test');
    expect(denied.body.rate_limit.bucket).toBe('ip');
    expect(Number(denied.headers['retry-after'])).toBeGreaterThanOrEqual(1);
  });

  it('charges the IP bucket even without a project_id (malformed bodies still count)', async () => {
    process.env.CF_INVOKE_RATE_LIMIT_PER_IP = '5';
    const res = await request(ipOnlyApp()).post('/v1/runtime/invoke').send({ version: '1' });
    expect(res.status).toBe(200); // admitted — role gate / validation answer it later
    expect(res.headers['x-ratelimit-limit']).toBe('5'); // IP headers present (SE-09 change)
  });

  it('the deprecated invokeRateLimit alias is the IP-only gate, never the project bucket', async () => {
    process.env.CF_INVOKE_RATE_LIMIT_PER_PROJECT = '1';
    process.env.CF_INVOKE_RATE_LIMIT_PER_IP = '100';
    const a = baseApp();
    a.post('/v1/runtime/invoke', invokeRateLimit, (_req, res) => res.json({ ok: true }));
    const send = () => request(a).post('/v1/runtime/invoke')
      .send({ project_id: 'p1', version: '1', tool_name: 't' });
    // Project limit is 1, but the alias never charges it: both pass.
    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(200);
  });
});

describe('SE-09 ordering: project bucket charges only after the role gate', () => {
  it('an outsider cannot burn a victim project quota (the F-4 wedge is closed)', async () => {
    process.env.CF_INVOKE_RATE_LIMIT_PER_PROJECT = '2';
    process.env.CF_INVOKE_RATE_LIMIT_PER_IP = '100';
    const app = orderedApp();
    const asOutsider = () => request(app).post('/v1/runtime/invoke')
      .send({ project_id: 'victim', version: '1', tool_name: 't' });
    const asMember = () => request(app).post('/v1/runtime/invoke')
      .set('x-test-member', 'yes')
      .send({ project_id: 'victim', version: '1', tool_name: 't' });
    // The outsider hammers the victim's project id well past its quota.
    // Every request 404s at the role gate; none may charge the bucket.
    for (let i = 0; i < 5; i++) expect((await asOutsider()).status).toBe(404);
    // The legitimate member still has the project's full quota.
    expect((await asMember()).status).toBe(200);
    expect((await asMember()).status).toBe(200);
    const denied = await asMember();
    expect(denied.status).toBe(429);
    expect(denied.body.rate_limit).toMatchObject({ bucket: 'project', limit: 2, remaining: 0 });
    // Another project from an admitted caller still flows.
    const other = await request(app).post('/v1/runtime/invoke')
      .set('x-test-member', 'yes')
      .send({ project_id: 'p2', version: '1', tool_name: 't' });
    expect(other.status).toBe(200);
  });

  it('admitted invokes report the project bucket headers (tighter than IP)', async () => {
    process.env.CF_INVOKE_RATE_LIMIT_PER_PROJECT = '5';
    process.env.CF_INVOKE_RATE_LIMIT_PER_IP = '100';
    const res = await request(orderedApp()).post('/v1/runtime/invoke')
      .set('x-test-member', 'yes')
      .send({ project_id: 'p1', version: '1', tool_name: 't' });
    expect(res.status).toBe(200);
    expect(res.headers['x-ratelimit-limit']).toBe('5');
    expect(res.headers['x-ratelimit-remaining']).toBe('4');
  });
});

// ─── invoke()-level: the data-plane gate ───────────────────────────────────

const VERSION = '1.0.0';
const BUNDLE = 'bundle-abc';
const signature = createHmac('sha256', 'dev-only-signing-secret')
  .update(`${VERSION}:${BUNDLE}`).digest('hex');

function mockReleaseAndTool(baseUrl: string) {
  oneMock
    .mockResolvedValueOnce({ id: 'r1', project_id: 'p1', version: VERSION, status: 'approved', bundle_hash: BUNDLE, signature })
    .mockResolvedValueOnce({
      tool_snapshot: {
        name: 'getThing',
        upstream: { base_url: baseUrl, path_template: '/thing', param_bindings: [] },
        recovery_rules: [],
      },
    });
}

const invokeReq = { project_id: 'p1', version: VERSION, tool_name: 'getThing', args: {}, client_ip: '10.0.0.1' };
const resp = (status: number, body = '{}') => ({ status, text: async () => body }) as Response;

describe('invoke rate-limit gate (BE-07)', () => {
  it('after the per-project limit, invokes fail RATE_LIMITED with no release lookup, no upstream call, telemetry + audit recorded', async () => {
    process.env.CF_INVOKE_RATE_LIMIT_PER_PROJECT = '2';
    process.env.CF_INVOKE_RATE_LIMIT_PER_IP = '100';
    const fetchMock = vi.fn().mockResolvedValue(resp(200, '{"ok":true}'));
    vi.stubGlobal('fetch', fetchMock);

    mockReleaseAndTool('https://api.example.com');
    expect((await invoke(invokeReq)).ok).toBe(true);
    mockReleaseAndTool('https://api.example.com');
    expect((await invoke(invokeReq)).ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(oneMock).toHaveBeenCalledTimes(4);

    const denied = await invoke(invokeReq); // no DB mocks queued: gate must fire first
    expect(denied.ok).toBe(false);
    expect(denied.error?.condition).toBe('RATE_LIMITED');
    expect(oneMock).toHaveBeenCalledTimes(4);        // no release/tool lookup for the denied invoke
    expect(fetchMock).toHaveBeenCalledTimes(2);     // upstream untouched
    // Telemetry records the rejection as rate_limited.
    const statuses = execMock.mock.calls
      .filter((c) => String(c[0]).includes('telemetry_events'))
      .map((c) => (c[1] as unknown[])[5]);
    expect(statuses).toContain('rate_limited');
    expect(auditMock).toHaveBeenCalledWith('p1', 'runtime.invoke.rate_limited', 'project', undefined,
      expect.objectContaining({ bucket: 'project', limit: 2 }));
    // Other projects are unaffected by p1's exhaustion.
    mockReleaseAndTool('https://api.example.com');
    expect((await invoke({ ...invokeReq, project_id: 'p2' })).ok).toBe(true);
  });

  it('rate_limit_checked requests are not double-charged (HTTP layer already admitted them)', async () => {
    process.env.CF_INVOKE_RATE_LIMIT_PER_PROJECT = '1';
    process.env.CF_INVOKE_RATE_LIMIT_PER_IP = '100';
    const fetchMock = vi.fn().mockResolvedValue(resp(200, '{"ok":true}'));
    vi.stubGlobal('fetch', fetchMock);
    // Two invokes with the flag: neither re-checks, both flow even above the nominal limit of 1.
    mockReleaseAndTool('https://api.example.com');
    expect((await invoke({ ...invokeReq, rate_limit_checked: true })).ok).toBe(true);
    mockReleaseAndTool('https://api.example.com');
    expect((await invoke({ ...invokeReq, rate_limit_checked: true })).ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('the window resets: after CF_INVOKE_RATE_WINDOW_MS the project can invoke again', async () => {
    process.env.CF_INVOKE_RATE_LIMIT_PER_PROJECT = '1';
    process.env.CF_INVOKE_RATE_LIMIT_PER_IP = '100';
    process.env.CF_INVOKE_RATE_WINDOW_MS = '30';
    const fetchMock = vi.fn().mockResolvedValue(resp(200, '{"ok":true}'));
    vi.stubGlobal('fetch', fetchMock);

    mockReleaseAndTool('https://api.example.com');
    expect((await invoke(invokeReq)).ok).toBe(true);
    expect((await invoke(invokeReq)).error?.condition).toBe('RATE_LIMITED');
    await new Promise((r) => setTimeout(r, 40)); // window elapses
    mockReleaseAndTool('https://api.example.com');
    expect((await invoke(invokeReq)).ok).toBe(true);
  });
});
