// EV-05 → EV-06: certification criteria — what the "Certified" badge means.
//
// Until now "passed" was a single bit: an eval run either passed overall
// or it didn't, and the safety suite was asserted, not verified. A badge
// customers show their own teams has to mean something checkable, so the
// criteria live here as one pure function over data eval already records
// (run status, suite summaries, per-scenario results, tool metadata).
// The verdict NEVER trusts the stored run status alone: every scenario
// result is re-counted, so a summary that disagrees with its results
// cannot certify.
//
// Criteria v2 (all must hold):
//   1. run_passed        — the run finished with status 'passed'.
//   2. contract_suite    — contract suite passed with ≥1 scenario, 0 failures.
//   3. behavior_suite    — behavior suite passed with ≥1 scenario, 0 failures.
//   4. recovery_suite    — recovery suite passed with ≥1 scenario, 0 failures.
//   5. auth_suite        — auth suite passed, OR 'not_tested' because no
//                          evaluated tool requires credentials. A failed
//                          auth suite (missing/rejected credential) blocks.
//   6. safety_verified   — the safety suite passed. Read-only tools are
//                          verified read-only; mutating/destructive tools
//                          must have passed the EV-06 write-safety
//                          scenarios (invalid payload rejected, idempotent
//                          replay, confirmation contract) — re-counted
//                          from the raw results, so a write tool cannot
//                          ride along on a green summary alone.
//   7. tool_coverage     — every evaluated tool produced ≥1 result in
//                          contract, behavior, and recovery (plus auth
//                          when the tool requires a credential, plus
//                          safety when the tool writes), so a tool can't
//                          ride along untested in a green run.
//
// Certification is a property of one eval run, computed when the run
// finishes (stored in the run summary) and recomputed on read for runs
// that predate the current criteria. It deliberately does NOT replace
// the release gate (tools must still be 'tested'); it is the stricter,
// explainable bar the badge displays. Criteria changes bump
// CERTIFICATION_CRITERIA_VERSION and old verdicts keep the version they
// were judged under. (v1 judged safety as read-only-only; EV-06 added
// write-safety scenarios, so v2 can certify write tools.)

export const CERTIFICATION_CRITERIA_VERSION = 'v2';

export interface CertificationCriterion {
  id: string;
  label: string;
  description: string;
}

/** The published rules — rendered in docs and mirrored by the console. */
export const CERTIFICATION_CRITERIA: CertificationCriterion[] = [
  {
    id: 'run_passed',
    label: 'Evaluation run passed',
    description: 'The evaluation run finished with an overall pass — every recorded scenario passed.',
  },
  {
    id: 'contract_suite',
    label: 'Contract suite passed',
    description: 'Every tool answered its happy-path call with a 2xx JSON response and handled missing required parameters without crashing.',
  },
  {
    id: 'behavior_suite',
    label: 'Behavior suite passed',
    description: 'Every tool’s response carried task-relevant fields (a non-empty result payload).',
  },
  {
    id: 'recovery_suite',
    label: 'Recovery suite passed',
    description: 'Invalid input produced a handled outcome (4xx or an empty result), never an unhandled error.',
  },
  {
    id: 'auth_suite',
    label: 'Auth verified',
    description: 'Tools that require a credential were probed with the real stored credential and it was accepted. Tools needing no credential satisfy this automatically.',
  },
  {
    id: 'safety_verified',
    label: 'Write safety verified',
    description: 'Read-only tools are verified read-only. Mutating and destructive tools passed the write-safety scenarios against the sandbox upstream: a wrong-type payload was rejected, idempotent calls replayed safely, and every write carries a confirmation contract so no destructive call fires without user confirmation.',
  },
  {
    id: 'tool_coverage',
    label: 'Every tool fully exercised',
    description: 'Each evaluated tool produced results in the contract, behavior, and recovery suites (the auth suite when it requires a credential, and the safety suite when it writes).',
  },
];

export interface CertificationCheck {
  id: string;
  label: string;
  status: 'pass' | 'fail';
  detail: string;
}

export interface CertificationVerdict {
  certified: boolean;
  criteria_version: string;
  checks: CertificationCheck[];
}

interface SuiteLike {
  status?: string;
  passed?: number;
  failed?: number;
  reason?: string;
}

interface ResultLike {
  tool_id: string;
  suite: string;
  scenario?: string;
  passed: boolean;
}

interface ToolLike {
  id: string;
  credential_mode?: string | null;
  effect_classes?: unknown;
  idempotent?: boolean | null;
}

export interface CertificationInput {
  runStatus: string;
  suites: Record<string, SuiteLike> | undefined;
  results: ResultLike[];
  tools: ToolLike[];
}

/** effect_classes arrives as a JS array (JSONB) or a JSON string (defensive). */
function effectClassesOf(tool: ToolLike): string[] {
  const raw = tool.effect_classes;
  if (Array.isArray(raw)) return raw.filter((v): v is string => typeof v === 'string');
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
    } catch {
      return [];
    }
  }
  return [];
}

function isReadOnly(tool: ToolLike): boolean {
  const classes = effectClassesOf(tool);
  return classes.length > 0 && classes.every((c) => c === 'read_only');
}

/** EV-06 write-safety scenarios every write tool must have passed. */
const WRITE_SAFETY_REQUIRED = ['write_invalid_payload_rejected', 'write_confirmation_contract'];

function suiteCheck(
  suites: Record<string, SuiteLike> | undefined,
  results: ResultLike[],
  suite: string,
  criterion: CertificationCriterion,
): CertificationCheck {
  const summary = suites?.[suite];
  const rows = results.filter((r) => r.suite === suite);
  const failed = rows.filter((r) => !r.passed).length;
  if (!summary) {
    return { id: criterion.id, label: criterion.label, status: 'fail', detail: `No ${suite} suite summary was recorded for this run.` };
  }
  if (summary.status !== 'passed') {
    return { id: criterion.id, label: criterion.label, status: 'fail', detail: `The ${suite} suite ${summary.status === 'not_tested' ? 'was not tested' : 'did not pass'}${summary.reason ? `: ${summary.reason}` : '.'}` };
  }
  if (rows.length === 0) {
    return { id: criterion.id, label: criterion.label, status: 'fail', detail: `The ${suite} suite recorded no scenarios — nothing was exercised.` };
  }
  if (failed > 0) {
    return { id: criterion.id, label: criterion.label, status: 'fail', detail: `${failed} of ${rows.length} ${suite} scenario(s) failed, despite the suite summary.` };
  }
  return { id: criterion.id, label: criterion.label, status: 'pass', detail: `All ${rows.length} ${suite} scenario(s) passed.` };
}

export function evaluateCertification(input: CertificationInput): CertificationVerdict {
  const { runStatus, suites } = input;
  // Defensive: a malformed result row must never throw — certification is
  // computed while finalizing an eval run, and a thrown verdict would
  // wedge the run in 'running' (the EV-01 lesson).
  const results = (Array.isArray(input.results) ? input.results : [])
    .filter((r) => r && typeof r === 'object' && r.tool_id != null && String(r.tool_id) !== '')
    .map((r) => ({ ...r, tool_id: String(r.tool_id), passed: r.passed === true }));
  const toolsIn = Array.isArray(input.tools) ? input.tools.filter((t) => t && t.id != null) : [];
  const byId = new Map(CERTIFICATION_CRITERIA.map((c) => [c.id, c]));
  const crit = (id: string) => byId.get(id)!;
  const checks: CertificationCheck[] = [];

  // 1 — overall run outcome.
  checks.push(runStatus === 'passed'
    ? { id: 'run_passed', label: crit('run_passed').label, status: 'pass', detail: 'The run finished with an overall pass.' }
    : { id: 'run_passed', label: crit('run_passed').label, status: 'fail', detail: `The run status is "${runStatus}", not "passed".` });

  // 2–4 — the three always-on suites, verified against raw results.
  checks.push(suiteCheck(suites, results, 'contract', crit('contract_suite')));
  checks.push(suiteCheck(suites, results, 'behavior', crit('behavior_suite')));
  checks.push(suiteCheck(suites, results, 'recovery', crit('recovery_suite')));

  // 5 — auth: passed, or not_tested because nothing needed a credential.
  const authSummary = suites?.['auth'];
  const authRows = results.filter((r) => r.suite === 'auth');
  const authFailed = authRows.filter((r) => !r.passed).length;
  if (authSummary?.status === 'not_tested' && authRows.length === 0) {
    checks.push({ id: 'auth_suite', label: crit('auth_suite').label, status: 'pass', detail: 'Not required — no evaluated tool requires credentials.' });
  } else if (authSummary?.status === 'passed' && authRows.length > 0 && authFailed === 0) {
    checks.push({ id: 'auth_suite', label: crit('auth_suite').label, status: 'pass', detail: `Stored credentials were accepted for all ${authRows.length} authenticated tool(s).` });
  } else if (!authSummary) {
    checks.push({ id: 'auth_suite', label: crit('auth_suite').label, status: 'fail', detail: 'No auth suite summary was recorded for this run.' });
  } else {
    checks.push({
      id: 'auth_suite', label: crit('auth_suite').label, status: 'fail',
      detail: authFailed > 0
        ? `${authFailed} auth check(s) failed (missing or rejected credential).`
        : 'The auth suite did not pass.',
    });
  }

  // Evaluated tools = the tools that actually produced results in this run.
  const evaluatedIds = [...new Set(results.map((r) => r.tool_id))];
  const toolById = new Map(toolsIn.map((t) => [String(t.id), t]));

  // 6 — safety (EV-06): read-only tools are verified read-only; write
  // tools must have passed their write-safety scenarios. Everything is
  // re-counted from raw results — the stored suite summary alone never
  // suffices, and a missing scenario is a failure, not a pass.
  const safetySummary = suites?.['safety'];
  const safetyRows = results.filter((r) => r.suite === 'safety');
  if (evaluatedIds.length === 0) {
    checks.push({ id: 'safety_verified', label: crit('safety_verified').label, status: 'fail', detail: 'No tools were evaluated in this run.' });
  } else if (safetySummary?.status !== 'passed') {
    checks.push({ id: 'safety_verified', label: crit('safety_verified').label, status: 'fail', detail: 'The safety suite did not pass for this run.' });
  } else {
    const failedSafety = safetyRows.filter((r) => !r.passed);
    const gaps: string[] = [];
    let readOnlyCount = 0;
    let writeCount = 0;
    for (const id of evaluatedIds) {
      const tool = toolById.get(id);
      if (tool && isReadOnly(tool)) {
        readOnlyCount += 1;
        continue;
      }
      // Missing tool row or non-read-only classification → write path.
      writeCount += 1;
      const passedScenarios = new Set(
        safetyRows.filter((r) => r.tool_id === id && r.passed).map((r) => r.scenario ?? ''),
      );
      for (const required of WRITE_SAFETY_REQUIRED) {
        if (!passedScenarios.has(required)) gaps.push(`${id.slice(0, 8)}… missing/passed ${required}`);
      }
      if (tool?.idempotent && !passedScenarios.has('write_replay_idempotent')) {
        gaps.push(`${id.slice(0, 8)}… missing/passed write_replay_idempotent`);
      }
    }
    if (failedSafety.length > 0) {
      checks.push({
        id: 'safety_verified', label: crit('safety_verified').label, status: 'fail',
        detail: `${failedSafety.length} write-safety scenario(s) failed — open the run to see which tool and why.`,
      });
    } else if (gaps.length > 0) {
      checks.push({
        id: 'safety_verified', label: crit('safety_verified').label, status: 'fail',
        detail: `Write-safety coverage gaps: ${gaps.join('; ')}. Re-run the evaluation under criteria v2.`,
      });
    } else {
      checks.push({
        id: 'safety_verified', label: crit('safety_verified').label, status: 'pass',
        detail: writeCount === 0
          ? `All ${readOnlyCount} evaluated tool(s) are read-only.`
          : `${readOnlyCount} read-only tool(s) verified; ${writeCount} write tool(s) passed the write-safety scenarios.`,
      });
    }
  }

  // 7 — per-tool coverage across the required suites.
  if (evaluatedIds.length === 0) {
    checks.push({ id: 'tool_coverage', label: crit('tool_coverage').label, status: 'fail', detail: 'No tools were evaluated in this run.' });
  } else {
    const gaps: string[] = [];
    for (const id of evaluatedIds) {
      const tool = toolById.get(id);
      const suitesForTool = new Set(results.filter((r) => r.tool_id === id).map((r) => r.suite));
      for (const suite of ['contract', 'behavior', 'recovery']) {
        if (!suitesForTool.has(suite)) gaps.push(`${id.slice(0, 8)}… missing ${suite}`);
      }
      const mode = tool?.credential_mode ?? 'none';
      if (tool && mode !== 'none' && !suitesForTool.has('auth')) {
        gaps.push(`${id.slice(0, 8)}… missing auth`);
      }
      // EV-06: a write tool must also have exercised the safety suite.
      if (tool && !isReadOnly(tool) && !suitesForTool.has('safety')) {
        gaps.push(`${id.slice(0, 8)}… missing safety`);
      }
    }
    checks.push(gaps.length === 0
      ? { id: 'tool_coverage', label: crit('tool_coverage').label, status: 'pass', detail: `Each of the ${evaluatedIds.length} evaluated tool(s) ran in every required suite.` }
      : { id: 'tool_coverage', label: crit('tool_coverage').label, status: 'fail', detail: `Coverage gaps: ${gaps.join('; ')}.` });
  }

  return {
    certified: checks.every((c) => c.status === 'pass'),
    criteria_version: CERTIFICATION_CRITERIA_VERSION,
    checks,
  };
}
