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
import { runEval, getRun, categorizeEvalFailure, summarizeToolOutcomes } from './eval.js';

const qMock = vi.mocked(q);
const execMock = vi.mocked(exec);
const oneMock = vi.mocked(one);

function toolRow(over: any = {}) {
  return {
    id: 'tool-1', project_id: 'p1', name: 'getForecast', version: 1, status: 'approved',
    // canonical_tools.effect_classes is NOT NULL (schema default read_only);
    // fixtures model the real row.
    effect_classes: JSON.stringify(['read_only']),
    input_schema: JSON.stringify({
      type: 'object',
      properties: { latitude: { type: 'number' } },
      required: ['latitude'],
    }),
    upstream: JSON.stringify({
      method: 'GET', path_template: '/forecast', base_url: 'https://api.test',
      param_bindings: [{ arg: 'latitude', location: 'query', target: 'latitude' }],
    }),
    ...over,
  };
}

function okFetch(status = 200, body: unknown = { ok: true }) {
  return vi.fn(async () => ({ status, text: async () => JSON.stringify(body) }));
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('categorizeEvalFailure + summarizeToolOutcomes (passed-only flow)', () => {
  it('labels key-plan failures distinctly from fixable contract failures', () => {
    expect(categorizeEvalFailure('auth', { status: 401 }).category).toBe('api_key_rejected');
    expect(categorizeEvalFailure('contract', { status: 403 }).category).toBe('access_not_allowed');
    expect(categorizeEvalFailure('contract', { status: 403 }).suggestion).toMatch(/plan/i);
    expect(categorizeEvalFailure('behavior', { status: 400 }).category).toBe('request_rejected');
    expect(categorizeEvalFailure('contract', { status: 200 }).category).toBe('contract_mismatch');
    expect(categorizeEvalFailure('contract', { error: 'request timed out' }).category).toBe('timeout');
  });

  it('counts passed vs failed tools and groups failures by category', () => {
    const out = summarizeToolOutcomes(
      [{ id: 't1', name: 'GetQuote' }, { id: 't2', name: 'GetBonds' }, { id: 't3', name: 'GetStocks' }],
      [
        { tool_id: 't1', suite: 'contract', scenario: 'happy_path_2xx_json', passed: true, detail: { status: 200 } },
        { tool_id: 't2', suite: 'auth', scenario: 'credential_configured', passed: false, detail: { status: 403 } },
        { tool_id: 't2', suite: 'contract', scenario: 'happy_path_2xx_json', passed: false, detail: { status: 403 } },
        { tool_id: 't3', suite: 'contract', scenario: 'happy_path_2xx_json', passed: false, detail: { status: 401 } },
      ],
    );
    expect(out).toMatchObject({ total: 3, passed: 1, failed: 2, passed_tool_ids: ['t1'] });
    expect(out.passed_tools).toEqual([{ tool_id: 't1', tool_name: 'GetQuote' }]);
    // t2's auth-suite failure categorizes as api_key_rejected (auth suite wins),
    // so that bucket holds 2 tools and sorts first.
    expect(out.failures_by_category.map((c) => c.category)).toEqual(['api_key_rejected', 'access_not_allowed']);
    expect(out.failed_tools.find((t) => t.tool_id === 't2')?.failed_scenarios).toBe(2);
  });
});

describe('runEval', () => {
  it('records results, reports per-tool progress, and passes a clean run', async () => {
    vi.stubGlobal('fetch', okFetch());
    qMock
      .mockResolvedValueOnce([toolRow()]) // tools
      .mockResolvedValueOnce([ // aggregation
        { tool_id: 'tool-1', suite: 'contract', passed: true }, { tool_id: 'tool-1', suite: 'contract', passed: true },
        { tool_id: 'tool-1', suite: 'behavior', passed: true }, { tool_id: 'tool-1', suite: 'recovery', passed: true },
      ]);

    const progress: Array<[number, number, string]> = [];
    const runId = await runEval('p1', 'manual', (d, t, n) => { progress.push([d, t, n]); });

    expect(runId).toMatch(/^uid-/);
    expect(progress).toEqual([[0, 1, 'Evaluating getForecast'], [1, 1, 'Running agent tasks']]);

    // Four scenario results recorded for the one tool.
    const resultInserts = execMock.mock.calls.filter((c) => String(c[0]).includes('INSERT INTO eval_results'));
    expect(resultInserts).toHaveLength(4);
    expect(resultInserts.map((c) => c[1]![4])).toEqual(
      ['happy_path_2xx_json', 'missing_params_handled', 'response_carries_task_fields', 'invalid_input_handled']);

    // API defaulted on missing required params, and answered 2xx to an
    // invalid value -> two review items for the queue.
    const reviewInserts = execMock.mock.calls.filter((c) => String(c[0]).includes('INSERT INTO review_items'));
    expect(reviewInserts).toHaveLength(2);
    expect(String(reviewInserts[0]![0])).toContain("'ambiguity'");
    expect(reviewInserts[0]![1]![3]).toMatch(/without required params/);
    expect(reviewInserts[1]![1]![3]).toMatch(/accepted an invalid/);

    // Run finalized as passed; approved tools promoted to tested.
    const update = execMock.mock.calls.find((c) => String(c[0]).includes('UPDATE eval_runs SET status'))!;
    expect(update[1]![0]).toBe('passed');
    const promote = execMock.mock.calls.find((c) => String(c[0]).includes("SET status = 'tested'"));
    expect(promote).toBeDefined();

    // EV-05: the stored summary carries the certification verdict — a clean
    // read-only run with full coverage certifies (criteria v2 since EV-06).
    const summary = JSON.parse(update[1]![1] as string);
    expect(summary.certification.criteria_version).toBe('v2');
    expect(summary.certification.certified).toBe(true);
    expect(summary.certification.checks.every((c: any) => c.status === 'pass')).toBe(true);
  });

  it('evaluates approved tools only — candidates never reach the run', async () => {
    vi.stubGlobal('fetch', okFetch());
    qMock
      .mockResolvedValueOnce([toolRow()]) // tools (already scope-filtered by the query)
      .mockResolvedValueOnce([
        { tool_id: 'tool-1', suite: 'contract', passed: true }, { tool_id: 'tool-1', suite: 'contract', passed: true },
        { tool_id: 'tool-1', suite: 'behavior', passed: true }, { tool_id: 'tool-1', suite: 'recovery', passed: true },
      ]);

    await runEval('p1');

    const toolsQuery = qMock.mock.calls.find((c) => String(c[0]).includes('FROM canonical_tools t'))!;
    expect(String(toolsQuery[0])).toContain("'approved','tested','released'");
    expect(String(toolsQuery[0])).not.toContain("'candidate'");
  });

  it('scoped runs filter tools by id and record the scope in the summary', async () => {
    vi.stubGlobal('fetch', okFetch());
    qMock
      .mockResolvedValueOnce([toolRow()]) // tools (route pre-validates membership)
      .mockResolvedValueOnce([ // aggregation
        { tool_id: 'tool-1', suite: 'contract', passed: true }, { tool_id: 'tool-1', suite: 'contract', passed: true },
        { tool_id: 'tool-1', suite: 'behavior', passed: true }, { tool_id: 'tool-1', suite: 'recovery', passed: true },
      ]);

    await runEval('p1', 'manual', () => {}, { toolIds: ['tool-1'] });

    const toolsQuery = qMock.mock.calls.find((c) => String(c[0]).includes('FROM canonical_tools t'))!;
    expect(String(toolsQuery[0])).toContain('ANY($2)');
    expect(toolsQuery[1]).toEqual(['p1', ['tool-1']]);

    const update = execMock.mock.calls.find((c) => String(c[0]).includes('UPDATE eval_runs SET status'))!;
    const summary = JSON.parse(update[1]![1] as string);
    expect(summary.scope).toEqual({ tool_ids: ['tool-1'], tool_count: 1 });
  });

  it('certifies a mutating tool that passes the write-safety scenarios (EV-06)', async () => {
    // Upstream with real validation: a wrong-type payload (number where a
    // string belongs) is rejected 400; everything else succeeds.
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: { body?: string }) => {
      const rejected = typeof init?.body === 'string' && init.body.includes('99999');
      return {
        status: rejected ? 400 : 200,
        text: async () => JSON.stringify(rejected ? { error: 'name must be a string' } : { ok: true }),
      };
    }));
    qMock
      .mockResolvedValueOnce([toolRow({
        name: 'createWidget',
        credential_mode: 'none',
        effect_classes: JSON.stringify(['mutating']),
        confirmation_required: true,
        idempotent: false,
        input_schema: JSON.stringify({
          type: 'object',
          properties: { name: { type: 'string' } },
          required: ['name'],
        }),
        upstream: JSON.stringify({
          method: 'POST', path_template: '/widgets', base_url: 'https://api.test',
          param_bindings: [{ arg: 'name', location: 'body', target: 'name' }],
        }),
      })])
      .mockResolvedValueOnce([
        { tool_id: 'tool-1', suite: 'contract', passed: true }, { tool_id: 'tool-1', suite: 'contract', passed: true },
        { tool_id: 'tool-1', suite: 'behavior', passed: true }, { tool_id: 'tool-1', suite: 'recovery', passed: true },
        { tool_id: 'tool-1', suite: 'safety', scenario: 'write_invalid_payload_rejected', passed: true },
        { tool_id: 'tool-1', suite: 'safety', scenario: 'write_confirmation_contract', passed: true },
      ]);

    await runEval('p1');

    // Six results: the four live scenarios plus both write-safety ones
    // (POST is not idempotent, so no replay scenario).
    const resultInserts = execMock.mock.calls.filter((c) => String(c[0]).includes('INSERT INTO eval_results'));
    expect(resultInserts.map((c) => c[1]![4])).toEqual([
      'happy_path_2xx_json', 'missing_params_handled', 'response_carries_task_fields', 'invalid_input_handled',
      'write_invalid_payload_rejected', 'write_confirmation_contract',
    ]);

    const update = execMock.mock.calls.find((c) => String(c[0]).includes('UPDATE eval_runs SET status'))!;
    expect(update[1]![0]).toBe('passed');
    const summary = JSON.parse(update[1]![1] as string);
    expect(summary.suites.safety.status).toBe('passed');
    expect(summary.suites.safety.passed).toBe(2);
    expect(summary.certification.criteria_version).toBe('v2');
    expect(summary.certification.certified).toBe(true);
    const safetyCheck = summary.certification.checks.find((c: any) => c.id === 'safety_verified');
    expect(safetyCheck.status).toBe('pass');
    // A passing run still promotes approved tools to tested.
    const promote = execMock.mock.calls.find((c) => String(c[0]).includes("SET status = 'tested'"));
    expect(promote).toBeDefined();
  });

  it('fails the run (and withholds certification) when a write accepts a wrong-type payload (EV-06)', async () => {
    // Lenient upstream: everything returns 200, so the malformed write
    // "lands" — the exact unsafe behavior the safety suite must catch.
    vi.stubGlobal('fetch', okFetch());
    qMock
      .mockResolvedValueOnce([toolRow({
        name: 'createWidget',
        credential_mode: 'none',
        effect_classes: JSON.stringify(['mutating']),
        confirmation_required: true,
        idempotent: false,
        input_schema: JSON.stringify({
          type: 'object',
          properties: { name: { type: 'string' } },
          required: ['name'],
        }),
        upstream: JSON.stringify({
          method: 'POST', path_template: '/widgets', base_url: 'https://api.test',
          param_bindings: [{ arg: 'name', location: 'body', target: 'name' }],
        }),
      })])
      .mockResolvedValueOnce([
        { tool_id: 'tool-1', suite: 'contract', passed: true }, { tool_id: 'tool-1', suite: 'contract', passed: true },
        { tool_id: 'tool-1', suite: 'behavior', passed: true }, { tool_id: 'tool-1', suite: 'recovery', passed: true },
        { tool_id: 'tool-1', suite: 'safety', scenario: 'write_invalid_payload_rejected', passed: false },
        { tool_id: 'tool-1', suite: 'safety', scenario: 'write_confirmation_contract', passed: true },
      ]);

    await runEval('p1');

    const update = execMock.mock.calls.find((c) => String(c[0]).includes('UPDATE eval_runs SET status'))!;
    expect(update[1]![0]).toBe('failed');
    const summary = JSON.parse(update[1]![1] as string);
    expect(summary.suites.safety.status).toBe('failed');
    expect(summary.certification.certified).toBe(false);
    const safetyCheck = summary.certification.checks.find((c: any) => c.id === 'safety_verified');
    expect(safetyCheck.status).toBe('fail');
    // A failed run never promotes tools.
    const promote = execMock.mock.calls.find((c) => String(c[0]).includes("SET status = 'tested'"));
    expect(promote).toBeUndefined();
  });

  it('replays an idempotent destructive tool and checks its confirmation contract (EV-06)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: { body?: string }) => {
      const rejected = (typeof init?.body === 'string' && init.body.includes('99999'))
        || String(url).includes('99999');
      return {
        status: rejected ? 400 : 200,
        text: async () => JSON.stringify(rejected ? { error: 'bad id' } : { ok: true }),
      };
    }));
    qMock
      .mockResolvedValueOnce([toolRow({
        name: 'deleteWidget',
        credential_mode: 'none',
        effect_classes: JSON.stringify(['destructive']),
        confirmation_required: false, // contract downgraded — must fail loudly
        idempotent: true,
        input_schema: JSON.stringify({
          type: 'object',
          properties: { widgetId: { type: 'string' } },
          required: ['widgetId'],
        }),
        upstream: JSON.stringify({
          method: 'DELETE', path_template: '/widgets/{widgetId}', base_url: 'https://api.test',
          param_bindings: [{ arg: 'widgetId', location: 'path', target: 'widgetId' }],
        }),
      })])
      .mockResolvedValueOnce([
        { tool_id: 'tool-1', suite: 'contract', passed: true }, { tool_id: 'tool-1', suite: 'contract', passed: true },
        { tool_id: 'tool-1', suite: 'behavior', passed: true }, { tool_id: 'tool-1', suite: 'recovery', passed: true },
        { tool_id: 'tool-1', suite: 'safety', scenario: 'write_invalid_payload_rejected', passed: true },
        { tool_id: 'tool-1', suite: 'safety', scenario: 'write_replay_idempotent', passed: true },
        { tool_id: 'tool-1', suite: 'safety', scenario: 'write_confirmation_contract', passed: false },
      ]);

    await runEval('p1');

    const resultInserts = execMock.mock.calls.filter((c) => String(c[0]).includes('INSERT INTO eval_results'));
    expect(resultInserts.map((c) => c[1]![4])).toContain('write_replay_idempotent');
    const confirmInsert = resultInserts.find((c) => c[1]![4] === 'write_confirmation_contract')!;
    expect(confirmInsert[1]![5]).toBe(false);

    const update = execMock.mock.calls.find((c) => String(c[0]).includes('UPDATE eval_runs SET status'))!;
    expect(update[1]![0]).toBe('failed');
    const summary = JSON.parse(update[1]![1] as string);
    expect(summary.certification.certified).toBe(false);
  });

  it('marks the run failed when scenarios fail and skips promotion', async () => {
    vi.stubGlobal('fetch', okFetch(500, { error: 'boom' }));
    qMock
      .mockResolvedValueOnce([toolRow({ id: 'tool-2', name: 'broken', input_schema: JSON.stringify({ type: 'object', properties: {}, required: [] }) })])
      .mockResolvedValueOnce([
        { suite: 'contract', passed: false },
        { suite: 'behavior', passed: false },
        { suite: 'recovery', passed: false },
      ]);

    await runEval('p1');

    const update = execMock.mock.calls.find((c) => String(c[0]).includes('UPDATE eval_runs SET status'))!;
    expect(update[1]![0]).toBe('failed');
    const summary = JSON.parse(update[1]![1] as string);
    expect(summary.suites.contract.status).toBe('failed');
    expect(summary.suites.auth.status).toBe('not_tested');

    const promote = execMock.mock.calls.find((c) => String(c[0]).includes("SET status = 'tested'"));
    expect(promote).toBeUndefined();
  });

  it('fails the auth suite loudly for a credentialed tool with no credential configured (AB-05)', async () => {
    vi.stubGlobal('fetch', okFetch());
    qMock
      .mockResolvedValueOnce([toolRow({ credential_mode: 'oauth' })]) // tools
      .mockResolvedValueOnce([ // aggregation
        { suite: 'contract', passed: true }, { suite: 'contract', passed: true },
        { suite: 'behavior', passed: true }, { suite: 'recovery', passed: true },
        { suite: 'auth', passed: false },
      ]);

    await runEval('p1');

    // Five results: the four live scenarios plus the auth credential check.
    const resultInserts = execMock.mock.calls.filter((c) => String(c[0]).includes('INSERT INTO eval_results'));
    expect(resultInserts).toHaveLength(5);
    const authInsert = resultInserts.find((c) => c[1]![3] === 'auth')!;
    expect(authInsert[1]![4]).toBe('credential_configured');
    expect(authInsert[1]![5]).toBe(false);
    expect(String(authInsert[1]![7])).toContain('CREDENTIAL_REQUIRED');
    expect(String(authInsert[1]![7])).toContain('Connect an account');

    // Run fails overall: auth summary is failed (not not_tested), no promotion.
    const update = execMock.mock.calls.find((c) => String(c[0]).includes('UPDATE eval_runs SET status'))!;
    expect(update[1]![0]).toBe('failed');
    const summary = JSON.parse(update[1]![1] as string);
    expect(summary.suites.auth).toEqual({ status: 'failed', passed: 0, failed: 1 });
    const promote = execMock.mock.calls.find((c) => String(c[0]).includes("SET status = 'tested'"));
    expect(promote).toBeUndefined();
  });

  it('records a failed scenario when fetch throws', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('socket hangup'); }));
    qMock
      .mockResolvedValueOnce([toolRow()])
      .mockResolvedValueOnce([{ suite: 'contract', passed: false }]);

    await runEval('p1');

    const resultInserts = execMock.mock.calls.filter((c) => String(c[0]).includes('INSERT INTO eval_results'));
    expect(resultInserts.length).toBeGreaterThan(0);
    expect(resultInserts[0]![1]![5]).toBe(false); // passed column
  });

  it('refuses to run with no approved tools instead of passing vacuously', async () => {
    qMock.mockResolvedValueOnce([]); // no in-scope tools

    await expect(runEval('p1')).rejects.toThrow('No approved tools to evaluate');
    const update = execMock.mock.calls.find((c) => String(c[0]).includes('UPDATE eval_runs SET status'))!;
    expect(update[0]).toContain("'failed'");
    // Nothing evaluated, nothing recorded.
    const results = execMock.mock.calls.filter((c) => String(c[0]).includes('INSERT INTO eval_results'));
    expect(results).toHaveLength(0);
  });
});

describe('getRun', () => {
  it('returns the run and its ordered results', async () => {
    oneMock.mockResolvedValue({ id: 'run-1', status: 'passed' });
    qMock.mockResolvedValue([{ id: 'r1' }, { id: 'r2' }]);
    const { run, results } = await getRun('run-1');
    expect(run).toMatchObject({ id: 'run-1' });
    expect(results).toHaveLength(2);
  });
});
