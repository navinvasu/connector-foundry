// DP-06: upstream timeouts + circuit breaker on the data plane.
// Breaker unit tests use an injected clock; invoke tests stub global fetch
// and the DB layer (same mocking pattern as runtime.test.ts / rollback.test.ts).
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

import { one } from './db.js';
import {
  invoke, UpstreamCircuitBreaker, breakerFor, resetUpstreamBreakers,
} from './runtime.js';

const oneMock = vi.mocked(one);

describe('UpstreamCircuitBreaker', () => {
  it('stays closed below the failure threshold and opens at it', () => {
    const b = new UpstreamCircuitBreaker(3, 1_000, () => 0);
    expect(b.canRequest()).toBe(true);
    b.recordFailure(); b.recordFailure();
    expect(b.snapshot()).toMatchObject({ state: 'closed', consecutive_failures: 2 });
    expect(b.canRequest()).toBe(true);
    b.recordFailure();
    expect(b.snapshot()).toMatchObject({ state: 'open', consecutive_failures: 3 });
    expect(b.canRequest()).toBe(false);
  });

  it('resets the failure count on success', () => {
    const b = new UpstreamCircuitBreaker(2, 1_000, () => 0);
    b.recordFailure();
    b.recordSuccess();
    expect(b.snapshot()).toEqual({ state: 'closed', consecutive_failures: 0, opened_at: null });
    b.recordFailure();
    expect(b.snapshot().state).toBe('closed');
  });

  it('allows exactly one half-open probe after the cooldown, and closes on its success', () => {
    let now = 0;
    const b = new UpstreamCircuitBreaker(1, 1_000, () => now);
    b.recordFailure();
    expect(b.canRequest()).toBe(false);
    now = 999;
    expect(b.canRequest()).toBe(false);
    now = 1_000;
    expect(b.canRequest()).toBe(true);            // the probe
    expect(b.snapshot().state).toBe('half_open');
    expect(b.canRequest()).toBe(false);           // no concurrent second probe
    b.recordSuccess();
    expect(b.snapshot()).toEqual({ state: 'closed', consecutive_failures: 0, opened_at: null });
    expect(b.canRequest()).toBe(true);
  });

  it('re-opens for a full cooldown when the half-open probe fails', () => {
    let now = 0;
    const b = new UpstreamCircuitBreaker(1, 1_000, () => now);
    b.recordFailure();
    now = 1_000;
    expect(b.canRequest()).toBe(true);
    b.recordFailure();                            // probe failed
    expect(b.snapshot()).toMatchObject({ state: 'open', opened_at: 1_000 });
    now = 1_999;
    expect(b.canRequest()).toBe(false);
    now = 2_000;
    expect(b.canRequest()).toBe(true);
  });

  it('breakerFor keys breakers by upstream origin', () => {
    resetUpstreamBreakers();
    const a = breakerFor('https://api.example.com/v1');
    expect(breakerFor('https://api.example.com/other')).toBe(a);
    expect(breakerFor('https://other.example.com/v1')).not.toBe(a);
  });
});

// ─── invoke-level: trips, fail-fast, timeout, automatic recovery ───────────

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

const req = { project_id: 'p1', version: VERSION, tool_name: 'getThing', args: {} };
const resp = (status: number, body = '{}') =>
  ({ status, text: async () => body }) as Response;

const ENV_KEYS = ['CF_CIRCUIT_FAILURE_THRESHOLD', 'CF_CIRCUIT_COOLDOWN_MS', 'CF_UPSTREAM_TIMEOUT_MS'];
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  vi.clearAllMocks();
  resetUpstreamBreakers();
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
  }
});

describe('invoke circuit breaker (DP-06)', () => {
  it('trips after consecutive 5xx and then fails fast without calling the upstream', async () => {
    process.env.CF_CIRCUIT_FAILURE_THRESHOLD = '2';
    process.env.CF_CIRCUIT_COOLDOWN_MS = '60000';
    const fetchMock = vi.fn().mockResolvedValue(resp(500));
    vi.stubGlobal('fetch', fetchMock);

    mockReleaseAndTool('https://api.example.com');
    expect((await invoke(req)).error?.condition).toBe('UPSTREAM_ERROR');
    mockReleaseAndTool('https://api.example.com');
    expect((await invoke(req)).error?.condition).toBe('UPSTREAM_ERROR');
    expect(fetchMock).toHaveBeenCalledTimes(2);

    mockReleaseAndTool('https://api.example.com');
    const third = await invoke(req);
    expect(third.ok).toBe(false);
    expect(third.error?.condition).toBe('UPSTREAM_CIRCUIT_OPEN');
    expect(fetchMock).toHaveBeenCalledTimes(2); // fail-fast: upstream untouched
  });

  it('a slow upstream times out (UPSTREAM_TIMEOUT) and the timeout trips the breaker', async () => {
    process.env.CF_CIRCUIT_FAILURE_THRESHOLD = '1';
    process.env.CF_CIRCUIT_COOLDOWN_MS = '60000';
    process.env.CF_UPSTREAM_TIMEOUT_MS = '25';
    const fetchMock = vi.fn((_url: any, opts: any) => new Promise((_resolve, reject) => {
      opts.signal.addEventListener('abort', () =>
        reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })));
    }));
    vi.stubGlobal('fetch', fetchMock);

    mockReleaseAndTool('https://slow.example.com');
    const first = await invoke(req);
    expect(first.ok).toBe(false);
    expect(first.error?.condition).toBe('UPSTREAM_TIMEOUT');

    mockReleaseAndTool('https://slow.example.com');
    const second = await invoke(req);
    expect(second.error?.condition).toBe('UPSTREAM_CIRCUIT_OPEN');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('recovers automatically: after the cooldown a successful probe closes the breaker', async () => {
    process.env.CF_CIRCUIT_FAILURE_THRESHOLD = '1';
    process.env.CF_CIRCUIT_COOLDOWN_MS = '30';
    const fetchMock = vi.fn().mockResolvedValueOnce(resp(503)).mockResolvedValue(resp(200, '{"ok":true}'));
    vi.stubGlobal('fetch', fetchMock);

    mockReleaseAndTool('https://flaky.example.com');
    expect((await invoke(req)).error?.condition).toBe('UPSTREAM_ERROR');
    mockReleaseAndTool('https://flaky.example.com');
    expect((await invoke(req)).error?.condition).toBe('UPSTREAM_CIRCUIT_OPEN');

    await new Promise((r) => setTimeout(r, 40)); // cooldown elapses
    mockReleaseAndTool('https://flaky.example.com');
    const probe = await invoke(req);
    expect(probe.ok).toBe(true);
    mockReleaseAndTool('https://flaky.example.com');
    expect((await invoke(req)).ok).toBe(true);   // closed again, traffic flows
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('per-request 4xx answers do not trip the breaker', async () => {
    process.env.CF_CIRCUIT_FAILURE_THRESHOLD = '1';
    const fetchMock = vi.fn().mockResolvedValueOnce(resp(400)).mockResolvedValue(resp(200, '{"ok":true}'));
    vi.stubGlobal('fetch', fetchMock);

    mockReleaseAndTool('https://strict.example.com');
    expect((await invoke(req)).error?.condition).toBe('BAD_REQUEST');
    mockReleaseAndTool('https://strict.example.com');
    expect((await invoke(req)).ok).toBe(true);   // breaker stayed closed
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
