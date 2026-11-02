import type { BackendEvalResult } from '../../data/api';

/**
 * EV-02: diff two eval runs so the console can show whether the API got
 * better or worse since the previous run.
 *
 * A scenario's identity across runs is (tool_id, suite, scenario) — the
 * result-row ids are minted fresh on every run, so they can't be matched.
 * "New failure" covers both regressions (passed before, fails now) and
 * brand-new scenarios that fail on first sight; still-failing scenarios
 * are counted but are not news.
 */
export type EvalChangeKind = 'regression' | 'new_failure' | 'fixed' | 'added' | 'removed';

export interface EvalScenarioChange {
  key: string;
  toolId: string | null;
  suite: string;
  scenario: string;
  kind: EvalChangeKind;
  before: 'pass' | 'fail' | 'absent';
  after: 'pass' | 'fail' | 'absent';
}

export interface EvalDiff {
  /** Every change, worst news first: regressions, new failures, fixed, added, removed. */
  changes: EvalScenarioChange[];
  /** Regressions + first-seen failures — the set the AC asks to highlight. */
  newFailures: EvalScenarioChange[];
  fixed: EvalScenarioChange[];
  added: EvalScenarioChange[];
  removed: EvalScenarioChange[];
  stillFailing: number;
  stillPassing: number;
  currentPass: number;
  currentTotal: number;
  previousPass: number;
  previousTotal: number;
  /** Percentage-point change in pass rate; null when either run is empty. */
  passRateDelta: number | null;
}

type ResultLike = Pick<BackendEvalResult, 'tool_id' | 'suite' | 'scenario' | 'passed'>;

export function evalScenarioKey(r: ResultLike): string {
  return `${r.tool_id ?? ''}|${r.suite}|${r.scenario}`;
}

function byKey(results: ResultLike[]): Map<string, ResultLike> {
  const map = new Map<string, ResultLike>();
  for (const r of results) map.set(evalScenarioKey(r), r);
  return map;
}

const KIND_ORDER: Record<EvalChangeKind, number> = {
  regression: 0,
  new_failure: 1,
  fixed: 2,
  added: 3,
  removed: 4,
};

export function diffEvalResults(
  previous: ResultLike[],
  current: ResultLike[],
): EvalDiff {
  const prev = byKey(previous);
  const curr = byKey(current);
  const changes: EvalScenarioChange[] = [];
  let stillFailing = 0;
  let stillPassing = 0;

  for (const [key, c] of curr) {
    const p = prev.get(key);
    const base = { key, toolId: c.tool_id, suite: c.suite, scenario: c.scenario };
    if (!p) {
      changes.push({
        ...base,
        kind: c.passed ? 'added' : 'new_failure',
        before: 'absent',
        after: c.passed ? 'pass' : 'fail',
      });
    } else if (p.passed && !c.passed) {
      changes.push({ ...base, kind: 'regression', before: 'pass', after: 'fail' });
    } else if (!p.passed && c.passed) {
      changes.push({ ...base, kind: 'fixed', before: 'fail', after: 'pass' });
    } else if (c.passed) {
      stillPassing += 1;
    } else {
      stillFailing += 1;
    }
  }
  for (const [key, p] of prev) {
    if (!curr.has(key)) {
      changes.push({
        key,
        toolId: p.tool_id,
        suite: p.suite,
        scenario: p.scenario,
        kind: 'removed',
        before: p.passed ? 'pass' : 'fail',
        after: 'absent',
      });
    }
  }

  changes.sort(
    (a, b) =>
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
      a.suite.localeCompare(b.suite) ||
      a.scenario.localeCompare(b.scenario),
  );

  const currentPass = current.filter((r) => r.passed).length;
  const previousPass = previous.filter((r) => r.passed).length;
  const passRateDelta =
    current.length > 0 && previous.length > 0
      ? Math.round((currentPass / current.length - previousPass / previous.length) * 100)
      : null;

  return {
    changes,
    newFailures: changes.filter((c) => c.kind === 'regression' || c.kind === 'new_failure'),
    fixed: changes.filter((c) => c.kind === 'fixed'),
    added: changes.filter((c) => c.kind === 'added'),
    removed: changes.filter((c) => c.kind === 'removed'),
    stillFailing,
    stillPassing,
    currentPass,
    currentTotal: current.length,
    previousPass,
    previousTotal: previous.length,
    passRateDelta,
  };
}

/** Scenario keys to highlight as new failures in the scenario matrix. */
export function newFailureKeys(diff: EvalDiff): Set<string> {
  return new Set(diff.newFailures.map((c) => c.key));
}
