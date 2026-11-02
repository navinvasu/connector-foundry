// AB-02 eval: the auth suite probes with the broker key (real results);
// missing/invalid keeps the loud AB-05 failure.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./db.js', () => ({
  one: vi.fn(),
  q: vi.fn(),
  exec: vi.fn(),
  J: {
    parse: (v: any, fb: any) =>
      v == null ? fb : typeof v === 'string' ? JSON.parse(v) : v,
  },
  jb: (v: unknown) => JSON.stringify(v),
  uid: (() => { let n = 0; return () => `uid-${++n}`; })(),
}));

import { one, q, exec } from './db.js';
import { runEval } from './eval.js';
import { VaultClient, DevKekProvider } from './broker/vault.js';

const DEV_KEY = '0123456789abcdef'.repeat(4);
const oneMock = vi.mocked(one);
const qMock = vi.mocked(q);
const execMock = vi.mocked(exec);

function toolRow(over: any = {}) {
  return {
    id: 'tool-1', project_id: 'p1', name: 'getForecast', version: 1, status: 'approved',
    credential_mode: 'api_key',
    // canonical_tools.effect_classes is NOT NULL (schema default read_only).
    effect_classes: JSON.stringify(['read_only']),
    input_schema: JSON.stringify({
      type: 'object',
      properties: { latitude: { type: 'number' } },
      required: ['latitude'],
    }),
    upstream: JSON.stringify({
      method: 'GET', path_template: '/forecast', base_url: 'https://api.test',
      param_bindings: [{ arg: 'latitude', location: 'query', target: 'latitude' }],
      auth_injection: { location: 'header', name: 'X-API-Key' },
    }),
    ...over,
  };
}

async function handleFor(key: string): Promise<string> {
  return (await new VaultClient(new DevKekProvider(DEV_KEY)).put(key)).handle;
}

function authInsert() {
  const inserts = execMock.mock.calls.filter((c) => String(c[0]).includes('INSERT INTO eval_results'));
  return inserts.find((c) => c[1]![3] === 'auth')!;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv('CF_BROKER_DEV_KEY', DEV_KEY);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('runEval auth suite with a broker key (AB-02)', () => {
  it('passes credential_configured with a real key and sends it on the probe', async () => {
    const fetchMock = vi.fn(async (_url: string, init: any) => ({
      status: 200, text: async () => JSON.stringify({ ok: true }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    const handle = await handleFor('probe-key-1');
    qMock
      .mockResolvedValueOnce([toolRow()])
      .mockResolvedValueOnce([
        { suite: 'contract', passed: true }, { suite: 'contract', passed: true },
        { suite: 'behavior', passed: true }, { suite: 'recovery', passed: true },
        { suite: 'auth', passed: true },
      ]);
    oneMock
      .mockResolvedValueOnce({ customer_id: 'c1' })
      .mockResolvedValueOnce({ vault_handle: handle });

    await runEval('p1');

    const auth = authInsert();
    expect(auth[1]![4]).toBe('credential_configured');
    expect(auth[1]![5]).toBe(true);
    expect(String(auth[1]![7])).toContain('CREDENTIAL_ACCEPTED');
    // EV-01: every scenario probe — not just the auth probe — carries the
    // key, so the tool is evaluated as the authenticated caller. (AB-02
    // asserted probe-only; EV-01 supersedes that.)
    const keyedCalls = fetchMock.mock.calls.filter((c) => c[1]?.headers?.['X-API-Key'] === 'probe-key-1');
    expect(keyedCalls).toHaveLength(fetchMock.mock.calls.length);
    expect(keyedCalls.length).toBeGreaterThanOrEqual(5);
    expect(keyedCalls[0][0]).toContain('https://api.test/forecast');
  });

  it('fails loudly when the upstream rejects the stored key', async () => {
    const fetchMock = vi.fn(async (_url: string, init: any) => ({
      // 401 whenever the (stale) key is presented; unauthenticated calls
      // still behave as before.
      status: init?.headers?.['X-API-Key'] ? 401 : 200,
      text: async () => JSON.stringify({ ok: true }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    const handle = await handleFor('stale-key');
    qMock
      .mockResolvedValueOnce([toolRow()])
      .mockResolvedValueOnce([
        { suite: 'contract', passed: true }, { suite: 'contract', passed: true },
        { suite: 'behavior', passed: true }, { suite: 'recovery', passed: true },
        { suite: 'auth', passed: false },
      ]);
    oneMock
      .mockResolvedValueOnce({ customer_id: 'c1' })
      .mockResolvedValueOnce({ vault_handle: handle });

    await runEval('p1');

    const auth = authInsert();
    expect(auth[1]![5]).toBe(false);
    expect(String(auth[1]![7])).toContain('CREDENTIAL_REJECTED');
    expect(String(auth[1]![7])).toContain('Rotate the credential');
  });

  it('keeps the byte-identical loud failure when no credential is configured', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: any): Promise<any> => ({ status: 200, text: async () => JSON.stringify({ ok: true }) }));
    vi.stubGlobal('fetch', fetchMock);
    qMock
      .mockResolvedValueOnce([toolRow()])
      .mockResolvedValueOnce([
        { suite: 'contract', passed: true }, { suite: 'contract', passed: true },
        { suite: 'behavior', passed: true }, { suite: 'recovery', passed: true },
        { suite: 'auth', passed: false },
      ]);
    oneMock
      .mockResolvedValueOnce({ customer_id: 'c1' })
      .mockResolvedValueOnce(undefined); // no active credential

    await runEval('p1');

    const auth = authInsert();
    expect(auth[1]![4]).toBe('credential_configured');
    expect(auth[1]![5]).toBe(false);
    expect(String(auth[1]![7])).toContain('CREDENTIAL_REQUIRED');
    // The message text is byte-identical to the AB-05 record; JSON escaping
    // and DP-05's redaction of the credential_mode value are pre-existing
    // storage behavior, so assert on the unescaped message body.
    expect(String(auth[1]![7])).toContain(
      'requires an API key, but no credential is configured for this project. Add a credential, then re-run eval.');
    // No probe went out with a key.
    expect(fetchMock.mock.calls.every((c) => !c[1]?.headers?.['X-API-Key'])).toBe(true);
  });

  it('evaluates a genuinely key-protected API end to end: 401 without the key, passing run with it (EV-01 AC)', async () => {
    const fetchMock = vi.fn(async (_url: string, init: any) => {
      const keyed = init?.headers?.['X-API-Key'] === 'real-key-7';
      return { status: keyed ? 200 : 401, text: async () => JSON.stringify({ ok: true }) };
    });
    vi.stubGlobal('fetch', fetchMock);
    const handle = await handleFor('real-key-7');
    qMock
      .mockResolvedValueOnce([toolRow()])
      .mockResolvedValueOnce([
        { suite: 'contract', passed: true }, { suite: 'contract', passed: true },
        { suite: 'behavior', passed: true }, { suite: 'recovery', passed: true },
        { suite: 'auth', passed: true },
      ]);
    oneMock
      .mockResolvedValueOnce({ customer_id: 'c1' })
      .mockResolvedValueOnce({ vault_handle: handle });

    await runEval('p1');

    // Every scenario + the auth probe ran authenticated.
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(5);
    expect(fetchMock.mock.calls.every((c) => c[1]?.headers?.['X-API-Key'] === 'real-key-7')).toBe(true);
    // All five recorded results passed, the run passed, and approved tools
    // were promoted to tested — "passed" means something (EV-01).
    const resultInserts = execMock.mock.calls.filter((c) => String(c[0]).includes('INSERT INTO eval_results'));
    expect(resultInserts).toHaveLength(5);
    expect(resultInserts.every((c) => c[1]![5] === true)).toBe(true);
    const update = execMock.mock.calls.find((c) => String(c[0]).includes('UPDATE eval_runs SET status'))!;
    expect(update[1]![0]).toBe('passed');
    expect(execMock.mock.calls.find((c) => String(c[0]).includes("SET status = 'tested'"))).toBeDefined();
  });

  it('injects a query-param key into probe URLs but never into stored evidence (EV-01 + DP-05)', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: any) => ({
      status: 200, text: async () => JSON.stringify({ ok: true }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    const handle = await handleFor('query-key-9');
    const queryTool = toolRow({
      upstream: JSON.stringify({
        method: 'GET', path_template: '/forecast', base_url: 'https://api.test',
        param_bindings: [{ arg: 'latitude', location: 'query', target: 'latitude' }],
        auth_injection: { location: 'query', name: 'api_key' },
      }),
    });
    qMock
      .mockResolvedValueOnce([queryTool])
      .mockResolvedValueOnce([
        { suite: 'contract', passed: true }, { suite: 'contract', passed: true },
        { suite: 'behavior', passed: true }, { suite: 'recovery', passed: true },
        { suite: 'auth', passed: true },
      ]);
    oneMock
      .mockResolvedValueOnce({ customer_id: 'c1' })
      .mockResolvedValueOnce({ vault_handle: handle });

    await runEval('p1');

    // The key reached the upstream on every probe URL…
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(5);
    expect(fetchMock.mock.calls.every((c) => String(c[0]).includes('api_key=query-key-9'))).toBe(true);
    // …but no stored eval detail (URL or otherwise) contains the material.
    const resultInserts = execMock.mock.calls.filter((c) => String(c[0]).includes('INSERT INTO eval_results'));
    expect(resultInserts.length).toBeGreaterThan(0);
    expect(resultInserts.every((c) => !String(c[1]![7]).includes('query-key-9'))).toBe(true);
  });

  it('fails loudly (never wedges the run) when a credential exists but the vault is unconfigured (EV-01)', async () => {
    vi.stubEnv('CF_BROKER_DEV_KEY', '');
    vi.stubEnv('CF_BROKER_KMS_KEY_ID', '');
    const fetchMock = vi.fn(async (_url: string, _init: any) => ({
      status: 200, text: async () => JSON.stringify({ ok: true }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    qMock
      .mockResolvedValueOnce([toolRow()])
      .mockResolvedValueOnce([
        { suite: 'contract', passed: true }, { suite: 'contract', passed: true },
        { suite: 'behavior', passed: true }, { suite: 'recovery', passed: true },
        { suite: 'auth', passed: false },
      ]);
    oneMock
      .mockResolvedValueOnce({ customer_id: 'c1' })
      .mockResolvedValueOnce({ vault_handle: 'cfv1.unused' }); // row exists; requireVault throws before any read

    await runEval('p1'); // must resolve — a throw here would strand the run in 'running'

    const auth = authInsert();
    expect(auth[1]![5]).toBe(false);
    expect(String(auth[1]![7])).toContain('CREDENTIAL_STORAGE_NOT_CONFIGURED');
    const update = execMock.mock.calls.find((c) => String(c[0]).includes('UPDATE eval_runs SET status'))!;
    expect(update[1]![0]).toBe('failed');
    // No unauthenticated-looking key ever went out.
    expect(fetchMock.mock.calls.every((c) => !c[1]?.headers?.['X-API-Key'])).toBe(true);
  });
});
