// EV-04: customer-authored scenarios run inside the normal eval
// (suite `custom`) and gate release — a failure fails the run, so the
// tool never promotes to `tested`.
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

import { q, exec } from './db.js';
import { runEval } from './eval.js';

const qMock = vi.mocked(q);
const execMock = vi.mocked(exec);

function toolRow(over: any = {}) {
  return {
    id: 'tool-1', project_id: 'p1', name: 'getForecast', version: 1, status: 'approved',
    effect_classes: JSON.stringify(['read_only']),
    input_schema: JSON.stringify({
      type: 'object',
      properties: { latitude: { type: 'number' }, longitude: { type: 'number' } },
      required: ['latitude', 'longitude'],
    }),
    upstream: JSON.stringify({
      method: 'GET', path_template: '/forecast', base_url: 'https://api.test',
      param_bindings: [
        { arg: 'latitude', location: 'query', target: 'latitude' },
        { arg: 'longitude', location: 'query', target: 'longitude' },
      ],
    }),
    custom_scenarios: [{
      id: 'scen-1', project_id: 'p1', tool_id: 'tool-1', name: 'Required args happy path',
      given_args: { latitude: 52.52, longitude: 13.41 },
      expect_status: 200, expect_body_keys: ['current'], enabled: true,
    }],
    ...over,
  };
}

function resultInserts() {
  return execMock.mock.calls.filter((c) => String(c[0]).includes('INSERT INTO eval_results'));
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('runEval with custom scenarios (EV-04)', () => {
  it('runs an enabled scenario in suite `custom` and passes the run', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      status: 200, text: async () => JSON.stringify({ current: { temperature_2m: 21 } }),
    })));
    qMock
      .mockResolvedValueOnce([toolRow()]) // tools (with custom_scenarios)
      .mockResolvedValueOnce([ // aggregation
        { tool_id: 'tool-1', suite: 'contract', passed: true },
        { tool_id: 'tool-1', suite: 'contract', passed: true },
        { tool_id: 'tool-1', suite: 'behavior', passed: true },
        { tool_id: 'tool-1', suite: 'recovery', passed: true },
        { tool_id: 'tool-1', suite: 'custom', scenario: 'Required args happy path', passed: true },
      ]);

    await runEval('p1');

    const inserts = resultInserts();
    const custom = inserts.filter((c) => c[1]![3] === 'custom');
    expect(custom).toHaveLength(1);
    expect(custom[0]![1]![4]).toBe('Required args happy path');
    expect(custom[0]![1]![5]).toBe(true);
    const detail = JSON.parse(custom[0]![1]![7] as string);
    expect(detail.scenario_id).toBe('scen-1');
    expect(detail.status).toBe(200);

    const update = execMock.mock.calls.find((c) => String(c[0]).includes('UPDATE eval_runs SET status'))!;
    expect(update[1]![0]).toBe('passed');
    const summary = JSON.parse(update[1]![1] as string);
    expect(summary.suites.custom).toEqual({ status: 'passed', passed: 1, failed: 0 });
    expect(execMock.mock.calls.some((c) => String(c[0]).includes("SET status = 'tested'"))).toBe(true);
  });

  it('fails the run (no `tested` promotion, certification blocked) when a custom case misses its expectation', async () => {
    // Upstream answers 200 but without the expected `current` key.
    vi.stubGlobal('fetch', vi.fn(async () => ({
      status: 200, text: async () => JSON.stringify({ daily: [] }),
    })));
    qMock
      .mockResolvedValueOnce([toolRow()])
      .mockResolvedValueOnce([
        { tool_id: 'tool-1', suite: 'contract', passed: true },
        { tool_id: 'tool-1', suite: 'contract', passed: true },
        { tool_id: 'tool-1', suite: 'behavior', passed: true },
        { tool_id: 'tool-1', suite: 'recovery', passed: true },
        { tool_id: 'tool-1', suite: 'custom', scenario: 'Required args happy path', passed: false },
      ]);

    await runEval('p1');

    const custom = resultInserts().filter((c) => c[1]![3] === 'custom');
    expect(custom[0]![1]![5]).toBe(false);
    const detail = JSON.parse(custom[0]![1]![7] as string);
    expect(detail.failures[0]).toContain('current');

    const update = execMock.mock.calls.find((c) => String(c[0]).includes('UPDATE eval_runs SET status'))!;
    expect(update[1]![0]).toBe('failed');
    const summary = JSON.parse(update[1]![1] as string);
    expect(summary.suites.custom.status).toBe('failed');
    // run_passed fails → not certified; tools stay unpromoted (release gate).
    expect(summary.certification.certified).toBe(false);
    expect(execMock.mock.calls.some((c) => String(c[0]).includes("SET status = 'tested'"))).toBe(false);
  });

  it('skips disabled scenarios and reports `custom` as honestly not_tested when none exist', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      status: 200, text: async () => JSON.stringify({ ok: true }),
    })));
    qMock
      .mockResolvedValueOnce([toolRow({
        custom_scenarios: [{
          id: 'scen-off', project_id: 'p1', tool_id: 'tool-1', name: 'Disabled case',
          given_args: {}, expect_status: 200, expect_body_keys: [], enabled: false,
        }],
      })])
      .mockResolvedValueOnce([
        { tool_id: 'tool-1', suite: 'contract', passed: true },
        { tool_id: 'tool-1', suite: 'contract', passed: true },
        { tool_id: 'tool-1', suite: 'behavior', passed: true },
        { tool_id: 'tool-1', suite: 'recovery', passed: true },
      ]);

    await runEval('p1');

    expect(resultInserts().some((c) => c[1]![3] === 'custom')).toBe(false);
    const update = execMock.mock.calls.find((c) => String(c[0]).includes('UPDATE eval_runs SET status'))!;
    const summary = JSON.parse(update[1]![1] as string);
    expect(summary.suites.custom.status).toBe('not_tested');
    expect(update[1]![0]).toBe('passed');
  });
});
