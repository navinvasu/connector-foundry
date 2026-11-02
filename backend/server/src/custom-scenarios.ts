// EV-04: customer-authored eval scenarios — pure expectation logic.
//
// Built-in suites probe generic behavior (happy path, missing params,
// invalid input, write-safety). EV-04 lets an API owner pin their own
// edge cases: *given args → expect shape/status*. An enabled scenario
// runs inside every evaluation (suite `custom`), as the authenticated
// caller (same probe path as the built-ins), and a failure fails the
// run — so it gates the `tested` promotion and therefore release,
// exactly like a built-in failure (AC: "runs inside the normal suite
// and gates release"). Certification stays criteria v2: a custom
// failure blocks via the `run_passed` check, not a new criterion.
//
// This module is the pure half — what a scenario expects and whether an
// observed response satisfies it — so it is unit-testable without a
// database or network. Persistence + HTTP live in
// `routes/eval-scenarios.ts`; execution lives in `eval.ts`.

import { J } from './db.js';

/** One customer-authored scenario, as stored (JSONB fields parsed). */
export interface CustomScenario {
  id: string;
  project_id: string;
  tool_id: string;
  name: string;
  given_args: Record<string, unknown>;
  expect_status: number | null;
  expect_body_keys: string[];
  enabled: boolean;
  created_by?: string | null;
  created_at?: unknown;
  updated_at?: unknown;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Parse a raw `eval_custom_scenarios` row (pg returns JSONB as objects;
 * TEXT-era rows as strings — defensive like every `J.parse` read). Rows
 * that cannot be a scenario return null so one malformed row never
 * wedges an eval run.
 */
export function parseCustomScenarioRow(raw: unknown): CustomScenario | null {
  if (!isRecord(raw)) return null;
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  const id = typeof raw.id === 'string' ? raw.id : '';
  const toolId = typeof raw.tool_id === 'string' ? raw.tool_id : '';
  if (!id || !toolId || !name) return null;
  const argsRaw = J.parse<unknown>(raw.given_args, {});
  const givenArgs = isRecord(argsRaw) ? argsRaw : {};
  const keysRaw = J.parse<unknown>(raw.expect_body_keys, []);
  const expectBodyKeys = Array.isArray(keysRaw)
    ? keysRaw.filter((k): k is string => typeof k === 'string' && k.trim() !== '').map((k) => k.trim())
    : [];
  const expectStatus = typeof raw.expect_status === 'number' && Number.isInteger(raw.expect_status)
    && raw.expect_status >= 100 && raw.expect_status <= 599
    ? raw.expect_status : null;
  return {
    id,
    project_id: typeof raw.project_id === 'string' ? raw.project_id : '',
    tool_id: toolId,
    name,
    given_args: givenArgs,
    expect_status: expectStatus,
    expect_body_keys: expectBodyKeys,
    enabled: raw.enabled !== false,
    created_by: typeof raw.created_by === 'string' ? raw.created_by : null,
    created_at: raw.created_at,
    updated_at: raw.updated_at,
  };
}

/** Normalize the tool-row `custom_scenarios` payload (json_agg or string). */
export function customScenariosOf(toolRow: { custom_scenarios?: unknown }): CustomScenario[] {
  const parsed = J.parse<unknown>(toolRow.custom_scenarios, []);
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map((r) => parseCustomScenarioRow(r))
    .filter((s): s is CustomScenario => s !== null && s.enabled);
}

export interface CustomExpectationVerdict {
  passed: boolean;
  /** Human-readable failures, empty when passed. */
  failures: string[];
  /** Top-level keys actually observed on an object body ([] otherwise). */
  bodyKeys: string[];
}

/**
 * Does one observed response satisfy a scenario's expectation?
 *
 * - `expect_status` set → the status must match exactly.
 * - `expect_status` unset → success (2xx) is expected. Pin an explicit
 *   4xx when the edge case is an error case.
 * - `expect_body_keys` → the body must be a JSON object carrying every
 *   listed key (top level).
 * A scenario with neither status nor keys still means "given these
 * args, the call succeeds" — never a vacuous pass.
 */
export function evaluateCustomExpectation(
  scenario: Pick<CustomScenario, 'expect_status' | 'expect_body_keys'>,
  observed: { status: number; body: unknown },
): CustomExpectationVerdict {
  const failures: string[] = [];
  const body = observed.body;
  const bodyKeys = isRecord(body) ? Object.keys(body) : [];
  if (scenario.expect_status !== null && scenario.expect_status !== undefined) {
    if (observed.status !== scenario.expect_status) {
      failures.push(`Expected HTTP ${scenario.expect_status}, got ${observed.status}.`);
    }
  } else if (!(observed.status >= 200 && observed.status < 300)) {
    failures.push(`Expected a 2xx success (no expect_status pinned), got ${observed.status}.`);
  }
  const wanted = scenario.expect_body_keys ?? [];
  if (wanted.length > 0) {
    if (!isRecord(body)) {
      failures.push('Expected a JSON object body carrying the expected keys, but the response body was not an object.');
    } else {
      for (const key of wanted) {
        if (!Object.hasOwn(body, key)) failures.push(`Expected response key "${key}" is missing.`);
      }
    }
  }
  return { passed: failures.length === 0, failures, bodyKeys };
}
