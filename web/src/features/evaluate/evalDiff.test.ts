import { describe, it, expect } from 'vitest';
import type { BackendEvalResult } from '../../data/api';
import { diffEvalResults, evalScenarioKey, newFailureKeys } from './evalDiff';

function result(over: Partial<BackendEvalResult> = {}): BackendEvalResult {
  return {
    id: 'r1', tool_id: 't1', suite: 'contract', scenario: 'happy_path_2xx_json',
    passed: true, latency_ms: 120, detail: { status: 200 },
    ...over,
  };
}

describe('evalScenarioKey', () => {
  it('is stable across runs (row ids differ, identity does not)', () => {
    const a = result({ id: 'run-a-row' });
    const b = result({ id: 'run-b-row' });
    expect(evalScenarioKey(a)).toBe(evalScenarioKey(b));
    expect(evalScenarioKey(a)).toBe('t1|contract|happy_path_2xx_json');
  });

  it('tolerates a null tool id', () => {
    expect(evalScenarioKey(result({ tool_id: null }))).toBe('|contract|happy_path_2xx_json');
  });
});

describe('diffEvalResults', () => {
  it('flags a pass→fail transition as a regression (a new failure)', () => {
    const diff = diffEvalResults([result({ passed: true })], [result({ passed: false })]);
    expect(diff.newFailures).toHaveLength(1);
    expect(diff.newFailures[0]).toMatchObject({ kind: 'regression', before: 'pass', after: 'fail' });
    expect(diff.passRateDelta).toBe(-100);
  });

  it('flags a first-seen failing scenario as a new failure, not a regression', () => {
    const diff = diffEvalResults([], [result({ passed: false })]);
    expect(diff.newFailures).toHaveLength(1);
    expect(diff.newFailures[0]).toMatchObject({ kind: 'new_failure', before: 'absent', after: 'fail' });
  });

  it('counts fail→pass as fixed and fail→fail as still failing (not news)', () => {
    const prev = [
      result({ scenario: 'a', passed: false }),
      result({ scenario: 'b', passed: false }),
    ];
    const curr = [
      result({ scenario: 'a', passed: true }),
      result({ scenario: 'b', passed: false }),
    ];
    const diff = diffEvalResults(prev, curr);
    expect(diff.fixed.map((c) => c.scenario)).toEqual(['a']);
    expect(diff.stillFailing).toBe(1);
    expect(diff.newFailures).toHaveLength(0);
    expect(diff.passRateDelta).toBe(50);
  });

  it('reports added (passing) and removed scenarios', () => {
    const diff = diffEvalResults(
      [result({ scenario: 'gone', passed: true })],
      [result({ scenario: 'fresh', passed: true })],
    );
    expect(diff.added.map((c) => c.scenario)).toEqual(['fresh']);
    expect(diff.removed.map((c) => c.scenario)).toEqual(['gone']);
    expect(diff.removed[0]).toMatchObject({ before: 'pass', after: 'absent' });
  });

  it('orders worst news first: regressions before fixes before additions', () => {
    const prev = [
      result({ scenario: 'reg', passed: true }),
      result({ scenario: 'fix', passed: false }),
    ];
    const curr = [
      result({ scenario: 'reg', passed: false }),
      result({ scenario: 'fix', passed: true }),
      result({ scenario: 'new', passed: true }),
    ];
    const diff = diffEvalResults(prev, curr);
    expect(diff.changes.map((c) => c.kind)).toEqual(['regression', 'fixed', 'added']);
  });

  it('matches scenarios per tool — the same scenario on another tool is separate', () => {
    const prev = [result({ tool_id: 't1', passed: true }), result({ tool_id: 't2', passed: true })];
    const curr = [result({ tool_id: 't1', passed: false }), result({ tool_id: 't2', passed: true })];
    const diff = diffEvalResults(prev, curr);
    expect(diff.newFailures).toHaveLength(1);
    expect(diff.newFailures[0].toolId).toBe('t1');
    expect(diff.stillPassing).toBe(1);
  });

  it('handles the first-run case (no previous results)', () => {
    const diff = diffEvalResults([], [result({ passed: true }), result({ scenario: 'x', passed: false })]);
    expect(diff.previousTotal).toBe(0);
    expect(diff.passRateDelta).toBeNull();
    expect(diff.newFailures.map((c) => c.scenario)).toEqual(['x']);
    expect(diff.added.map((c) => c.scenario)).toEqual(['happy_path_2xx_json']);
  });

  it('handles two empty runs', () => {
    const diff = diffEvalResults([], []);
    expect(diff.changes).toEqual([]);
    expect(diff.currentTotal).toBe(0);
    expect(diff.passRateDelta).toBeNull();
  });

  it('newFailureKeys keys match evalScenarioKey for matrix highlighting', () => {
    const failing = result({ passed: false });
    const diff = diffEvalResults([result({ passed: true })], [failing]);
    expect([...newFailureKeys(diff)]).toEqual([evalScenarioKey(failing)]);
  });
});
