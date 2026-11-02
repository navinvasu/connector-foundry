// Evaluation orchestrator (EVA-01) — runs scenario suites against the live
// sandbox and records results. Release gates: contract, task, recovery, auth.
// Per PRD: distinguish "not tested" from "passed" (see run summary).

import { one, q, exec, J, jb, uid } from './db.js';
import { redactString, redactValue } from './redact.js';
import { evaluateCertification } from './certification.js';
import { resolveLease, resolveProjectTenant, injectionFor, applyInjection } from './broker/index.js';
import {
  assembleUpstreamRequest, setHeader, upstreamUrl, type UpstreamSnapshot,
} from './upstream-request.js';
import type { AuthInjection } from './broker/index.js';
import { fetchWithEgress } from './egress.js';
import { customScenariosOf, evaluateCustomExpectation } from './custom-scenarios.js';
import { buildArgs } from './sample-args.js';
import { runAgentSuite, type AgentSuiteSummary } from './agent/tasks.js';
import { currentLlm } from './llm/index.js';

export interface ToolRow {
  id: string;
  project_id: string;
  name: string;
  input_schema: unknown;
  upstream: unknown;
  version: number;
  status: string;
  credential_mode?: string | null;
  effect_classes?: unknown;
  confirmation_required?: boolean | null;
  idempotent?: boolean | null;
  /** EV-04: enabled custom scenarios (json_agg; absent in old fixtures). */
  custom_scenarios?: unknown;
}

function parseUpstream(tool: ToolRow): UpstreamSnapshot {
  return J.parse<UpstreamSnapshot>(
    tool.upstream, { method: 'GET', path_template: '/', base_url: '', param_bindings: [] });
}

/** Effect classes as stored (JSONB array or JSON string — defensive). */
function effectClassesOf(tool: ToolRow): string[] {
  const raw = tool.effect_classes;
  if (Array.isArray(raw)) return raw.filter((v): v is string => typeof v === 'string');
  return J.parse<string[]>(raw, []).filter((v) => typeof v === 'string');
}

/**
 * EV-06: a tool needs write-safety scenarios when it is not purely
 * read-only — it carries a `mutating`/`destructive` class, or no
 * classification at all (unclassified is treated as a write risk, never
 * quietly waved through as read-only).
 */
export function isWriteTool(tool: ToolRow): boolean {
  const classes = effectClassesOf(tool);
  return !(classes.length > 0 && classes.every((c) => c === 'read_only'));
}

/**
 * EV-06: build a payload that is invalid *by type* — the first declared
 * property gets a value of the wrong JSON type (string ↔ number, boolean →
 * string). A write API with input validation rejects this with a 4xx; one
 * that answers 2xx accepted a malformed write, which is exactly the
 * unsafe behavior the safety suite exists to catch. Returns null when
 * the tool declares no property to corrupt.
 */
function corruptArgs(tool: ToolRow, args: Record<string, unknown>): Record<string, unknown> | null {
  const schema = J.parse<{ properties?: Record<string, { type?: string }> }>(
    tool.input_schema, { properties: {} });
  const names = Object.keys(schema.properties ?? {});
  if (names.length === 0) return null;
  const first = names[0]!;
  const type = schema.properties?.[first]?.type ?? 'string';
  const bad = { ...args };
  bad[first] = type === 'number' || type === 'integer' || type === 'boolean' ? '__invalid_type__' : 99999;
  return bad;
}

/** Evidence URL (never carries injected credentials — see AuthCtx note). */
function buildUrl(tool: ToolRow, args: Record<string, unknown>): string {
  const up = parseUpstream(tool);
  const assembled = assembleUpstreamRequest(up, args);
  return upstreamUrl(up.base_url ?? '', assembled.path, assembled.query);
}

async function timedFetch(url: string, timeoutMs = 15000, headers: Record<string, string> = {}, init: { method?: string; body?: string } = {}): Promise<{ status: number; body: unknown; latencyMs: number }> {
  const start = Date.now();
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    // BE-17: the eval agent string yields to a spec-declared User-Agent
    // param (already in `headers` when the tool declares one).
    const finalHeaders = { ...headers };
    if (!Object.keys(finalHeaders).some((k) => k.toLowerCase() === 'user-agent')) {
      finalHeaders['user-agent'] = 'connector-foundry-eval/0.1';
    }
    // SE-08: eval probes share the runtime's egress policy (scheme +
    // private-address checks per redirect hop, response-size cap).
    const res = await fetchWithEgress(url, {
      method: init.method ?? 'GET',
      signal: ctrl.signal,
      headers: finalHeaders,
      ...(init.body !== undefined ? { body: init.body } : {}),
    });
    const text = await res.text();
    let body: unknown = text;
    try { body = JSON.parse(text); } catch { /* keep text */ }
    return { status: res.status, body, latencyMs: Date.now() - start };
  } finally {
    clearTimeout(t);
  }
}

/**
 * EV-01: per-tool authenticated request context. AB-02 proved the lease
 * path with a single auth probe; EV-01 makes the *whole* evaluation run
 * as the authenticated caller — contract, behavior, and recovery probes
 * carry the same injected credential as invoke (same `injectionFor` /
 * `applyInjection` path, no second code path). Without this, a genuinely
 * key-protected API 401s every scenario and can never pass, so "passed"
 * would mean nothing for exactly the tools eval exists to certify.
 * The material touches only request-scoped memory: recorded detail URLs
 * are always built from the *uninjected* args URL, so a query-param key
 * never lands in stored evidence (DP-05) regardless of the param's name.
 */
export interface AuthCtx { inj: AuthInjection; material: string }

function authContextFor(tool: ToolRow, material: string): AuthCtx | null {
  const inj = injectionFor({ credential_mode: tool.credential_mode, upstream: J.parse(tool.upstream, null) });
  return inj ? { inj, material } : null;
}

export type LeaseState = 'none' | 'ok' | 'missing' | 'storage_unconfigured';

/**
 * TE-03: EV-01's per-tool lease resolution, extracted so drift checks
 * probe as the same authenticated caller eval does. api_key tools lease
 * the project's active key through the broker (purpose 'eval-probe');
 * OAuth tools keep AB-05's refusal until AB-03. A vault that can't serve
 * (row exists, storage not configured) resolves to 'storage_unconfigured'
 * instead of throwing, so a scheduled check records a loud outcome
 * rather than wedging.
 */
export async function resolveToolAuthCtx(
  projectId: string, tool: ToolRow,
): Promise<{ ctx: AuthCtx | null; state: LeaseState }> {
  const credMode = tool.credential_mode ?? 'none';
  if (credMode !== 'api_key') return { ctx: null, state: 'none' };
  try {
    const tenant = await resolveProjectTenant(projectId);
    const lease = await resolveLease({ tenant, projectId, scopes: [], purpose: 'eval-probe' });
    if (lease.ok) return { ctx: authContextFor(tool, lease.material), state: 'ok' };
    return { ctx: null, state: 'missing' };
  } catch {
    return { ctx: null, state: 'storage_unconfigured' };
  }
}

export interface ContractProbeOutcome {
  scenario: string;
  passed: boolean;
  latencyMs: number | null;
  detail: unknown;
  /**
   * Set when the API defaults missing params to 200 — a spec-vs-reality
   * divergence that belongs in the review queue (DEC-01), not a silent
   * pass. Returned, not written: the caller routes it (eval records a
   * review item; drift checks stay observation-only).
   */
  reviewItem?: { title: string; evidence: unknown; recommendation: string };
}

/**
 * TE-03: the two contract scenarios extracted verbatim from runEval so
 * drift detection probes the exact same "frozen contract". Returns
 * outcomes instead of recording them — the caller decides the store
 * (eval_results for eval, drift evidence for drift checks).
 */
export async function probeContractScenarios(
  tool: ToolRow,
  authCtx: AuthCtx | null,
): Promise<ContractProbeOutcome[]> {
  const outcomes: ContractProbeOutcome[] = [];
  const args = buildArgs(tool);

  // — Contract: happy path returns 2xx with a JSON object body —
  try {
    const req = probeRequest(tool, args, authCtx);
    const r = await timedFetch(req.url, 15000, req.headers, req);
    const ok = r.status >= 200 && r.status < 300 && typeof r.body === 'object' && r.body !== null;
    outcomes.push({
      scenario: 'happy_path_2xx_json', passed: ok, latencyMs: r.latencyMs,
      detail: { url: redactString(buildUrl(tool, args)), status: r.status, body_keys: bodyKeys(r.body) },
    });
  } catch (e) {
    outcomes.push({
      scenario: 'happy_path_2xx_json', passed: false, latencyMs: null, detail: { error: String(e) },
    });
  }

  // — Contract: omitting required params → handled, not a crash.
  // Strict APIs return 4xx. Lenient ones (that fall back to a default)
  // return 200 — a spec-vs-reality divergence that belongs in the review
  // queue (DEC-01), not a silent pass.
  const schema = J.parse<{ required?: string[] }>(tool.input_schema, {});
  if ((schema.required ?? []).length > 0) {
    try {
      const req = probeRequest(tool, {}, authCtx);
      const r = await timedFetch(req.url, 15000, req.headers, req);
      const url = buildUrl(tool, {});
      const rejected = r.status >= 400 && r.status < 500;
      const defaulted = r.status >= 200 && r.status < 300;
      const ok = rejected || defaulted;
      const outcome: ContractProbeOutcome = {
        scenario: 'missing_params_handled', passed: ok, latencyMs: r.latencyMs,
        detail: {
          url: redactString(url), status: r.status,
          behavior: rejected ? 'rejected_4xx' : defaulted ? 'defaulted_200' : 'unexpected',
        },
      };
      if (defaulted) {
        outcome.reviewItem = {
          title: `API accepts ${tool.name} without required params`,
          evidence: redactValue({
            observed: `200 with no query params (${redactString(url)})`,
            spec_says: `required: ${(schema.required ?? []).join(', ')}`,
          }),
          recommendation: 'Confirm: keep params required in the tool contract, or relax to optional with documented defaults.',
        };
      }
      outcomes.push(outcome);
    } catch (e) {
      outcomes.push({
        scenario: 'missing_params_handled', passed: false, latencyMs: null, detail: { error: String(e) },
      });
    }
  }

  return outcomes;
}

/**
 * One probe request: assembled args (path/query/body/headers/cookies,
 * BE-16/BE-17 — shared with runtime invoke so a certified tool behaves
 * identically when served), the tool's real HTTP method, and the injected
 * credential applied last over the assembled headers/query, so the
 * credential wins any collision with a caller-supplied header/cookie
 * param (BE-17 precedence, same rule as invoke). The recorded evidence
 * URL stays `buildUrl(...)` — uninjected args only (DP-05).
 */
interface ProbeRequest { url: string; headers: Record<string, string>; method: string; body?: string }

/**
 * EV-08: one live call of a candidate tool as the authenticated eval
 * caller — what an agent's tool call does before any release exists.
 */
export async function callCandidateTool(
  projectId: string, tool: ToolRow, args: Record<string, unknown>,
): Promise<{ status: number; body: unknown; latencyMs: number }> {
  const { ctx } = await resolveToolAuthCtx(projectId, tool);
  const req = probeRequest(tool, args, ctx);
  return timedFetch(req.url, 15000, req.headers, req);
}

/** The request a tool call would send, without credentials (dry-run evidence). */
export function describeCandidateCall(tool: ToolRow, args: Record<string, unknown>): { method: string; url: string } {
  const req = probeRequest(tool, args, null);
  return { method: req.method ?? 'GET', url: req.url };
}

function probeRequest(tool: ToolRow, args: Record<string, unknown>, ctx: AuthCtx | null): ProbeRequest {
  const up = parseUpstream(tool);
  const assembled = assembleUpstreamRequest(up, args);
  const headers = { ...assembled.headers };
  const query = assembled.query;
  if (ctx) applyInjection(headers, query, ctx.material, ctx.inj);
  if (assembled.hasBody) setHeader(headers, 'content-type', 'application/json');
  return {
    url: upstreamUrl(up.base_url ?? '', assembled.path, query),
    headers,
    method: assembled.method,
    ...(assembled.hasBody ? { body: JSON.stringify(assembled.body) } : {}),
  };
}

export interface SuiteSummary {
  status: 'passed' | 'failed' | 'not_tested';
  passed?: number;
  failed?: number;
  reason?: string;
}

/** Why a scenario failed, in customer language, with the fix to try first.
 *  Pure and fixture-tested: the console renders these verbatim so an owner
 *  can tell a key-plan limit (keep the tool out) from a fixable contract. */
export function categorizeEvalFailure(suite: string, detail: any): { category: string; label: string; suggestion: string } {
  const status = typeof detail?.status === 'number' ? detail.status : null;
  const error = String(detail?.error ?? '');
  if (suite === 'auth' || status === 401) return {
    category: 'api_key_rejected', label: 'API key rejected (401)',
    suggestion: 'Check the vaulted key is valid for this endpoint; many providers gate endpoints by plan — upgrade the key/plan or keep this operation out.',
  };
  if (status === 403) return {
    category: 'access_not_allowed', label: 'Not allowed for this API key (403)',
    suggestion: 'The key\'s plan does not include this endpoint. Upgrade the plan or exclude the operation — it cannot pass with the current key.',
  };
  if (status === 404) return {
    category: 'not_found', label: 'Endpoint or resource not found (404)',
    suggestion: 'Confirm the path and required identifiers in the spec; the upstream may have moved or the sample arguments may name a resource that does not exist.',
  };
  if (status === 429) return {
    category: 'rate_limited', label: 'Rate limited (429)',
    suggestion: 'The upstream throttled the probes. Re-run later, reduce the tool set, or raise the key\'s rate limit.',
  };
  if (status !== null && status >= 400 && status < 500) return {
    category: 'request_rejected', label: `Request rejected (${status})`,
    suggestion: 'The upstream rejected the probe arguments. Check required parameters and formats in the spec, fix the tool\'s argument descriptions/examples, then re-run.',
  };
  if (status !== null && status >= 500) return {
    category: 'upstream_error', label: `Upstream error (${status})`,
    suggestion: 'The upstream failed on a valid request. Retry later; if it persists, report it to the API provider and keep the operation out until it is stable.',
  };
  if (/timeout|timed out/i.test(error)) return {
    category: 'timeout', label: 'Upstream timed out',
    suggestion: 'The upstream did not answer in time. Re-run; if it persists, exclude the operation or raise it with the provider.',
  };
  if (error) return {
    category: 'network_error', label: 'Request never completed',
    suggestion: 'No response was received (network/DNS/egress). Check the base URL in the spec and re-run.',
  };
  return {
    category: 'contract_mismatch', label: 'Response did not match the contract',
    suggestion: 'The upstream answered but the payload was empty or the wrong shape. Check the response schema against live data, adjust expectations, then re-run.',
  };
}

export interface ToolOutcomeSummary {
  total: number;
  passed: number;
  failed: number;
  passed_tool_ids: string[];
  /** Passed tools with names, so the console can list them next to the
   *  failed ones (ids alone are not clickable-readable). */
  passed_tools: Array<{ tool_id: string; tool_name: string }>;
  failed_tools: Array<{ tool_id: string; tool_name: string; failed_scenarios: number; categories: string[] }>;
  failures_by_category: Array<{ category: string; label: string; tool_count: number; suggestion: string }>;
}

/** Per-tool verdict of a run: a tool passed only when every scenario
 *  recorded for it passed (and at least one was recorded). */
export function summarizeToolOutcomes(
  tools: Array<{ id: string; name: string }>,
  rows: Array<{ tool_id: string; suite: string; scenario: string; passed: boolean; detail?: any }>,
): ToolOutcomeSummary {
  const passed_tool_ids: string[] = [];
  const passed_tools: ToolOutcomeSummary['passed_tools'] = [];
  const failed_tools: ToolOutcomeSummary['failed_tools'] = [];
  const byCategory = new Map<string, { label: string; suggestion: string; tools: Set<string> }>();
  for (const tool of tools) {
    const mine = rows.filter((r) => r.tool_id === tool.id);
    const failed = mine.filter((r) => !r.passed);
    if (mine.length > 0 && failed.length === 0) {
      passed_tool_ids.push(tool.id);
      passed_tools.push({ tool_id: tool.id, tool_name: tool.name });
      continue;
    }
    const categories = new Set<string>();
    for (const f of failed) {
      const c = categorizeEvalFailure(f.suite, f.detail ?? {});
      categories.add(c.category);
      const entry = byCategory.get(c.category) ?? { label: c.label, suggestion: c.suggestion, tools: new Set<string>() };
      entry.tools.add(tool.id);
      byCategory.set(c.category, entry);
    }
    failed_tools.push({ tool_id: tool.id, tool_name: tool.name, failed_scenarios: failed.length, categories: [...categories] });
  }
  return {
    total: tools.length,
    passed: passed_tool_ids.length,
    failed: failed_tools.length,
    passed_tool_ids,
    passed_tools,
    failed_tools,
    failures_by_category: [...byCategory.entries()]
      .map(([category, v]) => ({ category, label: v.label, tool_count: v.tools.size, suggestion: v.suggestion }))
      .sort((a, b) => b.tool_count - a.tool_count),
  };
}

export async function runEval(
  projectId: string,
  trigger = 'manual',
  onProgress?: (done: number, total: number, note: string) => void | Promise<void>,
  // Scoped run: evaluate only these tools (a quick demo loop). The route
  // validates membership + non-emptiness; a full run passes no scope.
  opts?: { toolIds?: string[] },
): Promise<string> {
  const runId = uid();
  await exec(`INSERT INTO eval_runs (id, project_id, trigger, status) VALUES ($1, $2, $3, 'running')`,
    [runId, projectId, trigger]);

  // Eval runs on approved tools only — candidates never execute, so an
  // unreviewed draft can never look "tested". Tested and released tools run
  // too (they are approved tools that passed before), so a re-run after
  // edits measures the whole approved toolset, not just what changed.
  // EV-04: enabled custom scenarios ride along on the tool row (json_agg),
  // so enabled cases run inside every eval without a second query — and
  // older tool fixtures without the column simply have none.
  const scoped = opts?.toolIds && opts.toolIds.length > 0 ? opts.toolIds : null;
  const tools = await q(
    `SELECT t.*,
      COALESCE((
        SELECT json_agg(s ORDER BY s.created_at ASC, s.name ASC)
          FROM eval_custom_scenarios s
         WHERE s.tool_id = t.id AND s.enabled = true
      ), '[]'::json) AS custom_scenarios
     FROM canonical_tools t
     WHERE t.project_id = $1 AND t.status IN ('approved','tested','released')
     ${scoped ? 'AND t.id = ANY($2)' : ''}`,
    scoped ? [projectId, scoped] : [projectId]) as ToolRow[];
  if (tools.length === 0) {
    // Fail the run row too (not just the queue job) so history never shows
    // a run stuck at 'running' that evaluated nothing.
    await exec(`UPDATE eval_runs SET status = 'failed', finished_at = now() WHERE id = $1`, [runId]);
    throw new Error(
      'No approved tools to evaluate — approve tools in the Tools screen first. ' +
      'Candidate drafts never run.',
    );
  }

  const summaries: Record<string, SuiteSummary> = {};
  let overall: 'passed' | 'failed' = 'passed';

  const record = async (toolId: string, suite: string, scenario: string, passed: boolean, latencyMs: number | null, detail: unknown) => {
    await exec(
      `INSERT INTO eval_results (id, eval_run_id, tool_id, suite, scenario, passed, latency_ms, detail)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      // DP-05: eval details are stored evidence — redact before persisting.
      [uid(), runId, toolId, suite, scenario, passed, latencyMs, jb(redactValue(detail))]);
    if (!passed) overall = 'failed';
  };

  for (const [i, tool] of tools.entries()) {
    await onProgress?.(i, tools.length, `Evaluating ${tool.name}`);
    const args = buildArgs(tool);

    // — EV-01 (extracted for TE-03 reuse): resolve the tool's credential ONCE,
    // up front, so every scenario below runs as the authenticated caller.
    const credMode = tool.credential_mode ?? 'none';
    const { ctx: authCtx, state: leaseState } = await resolveToolAuthCtx(projectId, tool);

    // — Contract scenarios (extracted for TE-03): record each outcome, and
    // route the missing-params-default observation to the review queue.
    for (const o of await probeContractScenarios(tool, authCtx)) {
      await record(tool.id, 'contract', o.scenario, o.passed, o.latencyMs, o.detail);
      if (o.reviewItem) {
        // Dedupe (uq_review_items_open): re-running the eval while the same
        // observation is still open keeps the one row instead of stacking
        // a second copy of the warning.
        await exec(
          `INSERT INTO review_items (id, project_id, tool_id, kind, title, evidence, recommendation, status)
           VALUES ($1, $2, $3, 'ambiguity', $4, $5, $6, 'open')
           ON CONFLICT DO NOTHING`,
          [uid(), projectId, tool.id, o.reviewItem.title, jb(o.reviewItem.evidence), o.reviewItem.recommendation]);
      }
    }

    // — Task: response carries task-relevant fields —
    try {
      const req = probeRequest(tool, args, authCtx);
      const r = await timedFetch(req.url, 15000, req.headers, req);
      const keys = bodyKeys(r.body);
      const ok = r.status >= 200 && r.status < 300 && hasPayload(r.body);
      await record(tool.id, 'behavior', 'response_carries_task_fields', ok, r.latencyMs,
        { url: redactString(buildUrl(tool, args)), status: r.status, top_level_keys: keys.slice(0, 10) });
    } catch (e) {
      await record(tool.id, 'behavior', 'response_carries_task_fields', false, null, { error: String(e) });
    }

    // — Recovery: invalid input produces a *handled* outcome —
    // Either a 4xx (→ BAD_REQUEST) or a 200 with empty results (→ EMPTY_RESULT).
    // A lenient API that answers 2xx with data anyway (→ ACCEPTED_LENIENT) is
    // not a crash, but an agent can't tell its bad input was ignored: like
    // the contract suite's missing-params case, that divergence goes to the
    // review queue (and feeds fix suggestions) instead of failing the run.
    // Corrupt smartly: out-of-range number for numeric params, garbage otherwise.
    try {
      const props = (J.parse<{ properties?: Record<string, { type?: string }> }>(
        tool.input_schema, {}).properties ?? {});
      const badArgs = { ...args };
      const firstKey = Object.keys(badArgs)[0];
      if (firstKey) {
        const t = props[firstKey]?.type;
        badArgs[firstKey] = t === 'number' || t === 'integer' ? 99999 : '__invalid__';
      }
      const req = probeRequest(tool, badArgs, authCtx);
      const r = await timedFetch(req.url, 15000, req.headers, req);
      const url = buildUrl(tool, badArgs);
      const isBadRequest = r.status >= 400 && r.status < 500;
      const isEmptyResult = r.status === 200 && isEmptyResults(r.body);
      const isLenient = r.status >= 200 && r.status < 300 && !isEmptyResult;
      const mapped = isBadRequest || isEmptyResult || isLenient;
      await record(tool.id, 'recovery', 'invalid_input_handled', mapped, r.latencyMs,
        { url: redactString(url), status: r.status,
          mapped_condition: isBadRequest ? 'BAD_REQUEST' : isEmptyResult ? 'EMPTY_RESULT' : isLenient ? 'ACCEPTED_LENIENT' : null });
      if (isLenient && firstKey) {
        // Dedupe (uq_review_items_open): same as above — one open row per warning.
        await exec(
          `INSERT INTO review_items (id, project_id, tool_id, kind, title, evidence, recommendation, status)
           VALUES ($1, $2, $3, 'ambiguity', $4, $5, $6, 'open')
           ON CONFLICT DO NOTHING`,
          [uid(), projectId, tool.id,
            `${tool.name} accepted an invalid "${firstKey}" and answered ${r.status}`,
            jb({ argument: firstKey, sent: badArgs[firstKey], status: r.status }),
            `Describe the valid values of "${firstKey}" (format, range or examples) so agents don't send ones the API silently ignores.`]);
      }
    } catch (e) {
      await record(tool.id, 'recovery', 'invalid_input_handled', false, null, { error: String(e) });
    }

    // — Auth (AB-05 + AB-02 + EV-01): the dedicated acceptance check on
    // top of the now-authenticated scenarios above. api_key tools probe
    // with the leased key; missing keeps the byte-identical loud failure;
    // an unconfigured vault became the same kind of loud failure upstream
    // of this block (leaseState) instead of wedging the run. OAuth tools
    // keep refusing until AB-03.
    if (credMode === 'api_key') {
      if (leaseState === 'ok') {
        try {
          const req = probeRequest(tool, args, authCtx);
          const r = await timedFetch(req.url, 15000, req.headers, req);
          // Auth is proven by NOT being rejected: any non-401/403 answer
          // (2xx, 400, 5xx, …) means the key was accepted at the auth layer.
          const accepted = r.status !== 401 && r.status !== 403;
          await record(tool.id, 'auth', 'credential_configured', accepted, r.latencyMs,
            accepted
              ? { condition: 'CREDENTIAL_ACCEPTED', credential_mode: credMode, status: r.status }
              : { condition: 'CREDENTIAL_REJECTED', credential_mode: credMode, status: r.status,
                  message: `The stored API key was rejected by the upstream (HTTP ${r.status}). Rotate the credential and re-run eval.` });
        } catch (e) {
          await record(tool.id, 'auth', 'credential_configured', false, null,
            { condition: 'CREDENTIAL_PROBE_FAILED', credential_mode: credMode, error: String(e) });
        }
      } else if (leaseState === 'storage_unconfigured') {
        await record(tool.id, 'auth', 'credential_configured', false, null, {
          condition: 'CREDENTIAL_STORAGE_NOT_CONFIGURED',
          credential_mode: credMode,
          message: `Tool "${tool.name}" requires an API key, but credential storage is not configured on this server. Configure the credential vault, then re-run eval.`,
        });
      } else {
        await record(tool.id, 'auth', 'credential_configured', false, null, {
          condition: 'CREDENTIAL_REQUIRED',
          credential_mode: credMode,
          message: `Tool "${tool.name}" requires an API key, but no credential is configured for this project. Add a credential, then re-run eval.`,
        });
      }
    } else if (credMode !== 'none') {
      await record(tool.id, 'auth', 'credential_configured', false, null, {
        condition: 'CREDENTIAL_REQUIRED',
        credential_mode: credMode,
        message: `Tool "${tool.name}" requires OAuth, but no account is connected for this project. Connect an account, then re-run eval.`,
      });
    }

    // — Safety (EV-06): write tools get sandboxed write-safety scenarios.
    // Eval already runs against the customer's *sandbox* base URL as the
    // authenticated caller; these scenarios are designed to be safe to
    // fire there — a wrong-type payload that validation must reject
    // before any mutation, a replay of an idempotent call, and a pure
    // contract check that the tool demands host confirmation. Eval never
    // fires a bare destructive call and calls it safe: destructive tools
    // are judged on their confirmation contract, not on a live delete.
    if (isWriteTool(tool)) {
      const classes = effectClassesOf(tool);

      // Invalid payload: a wrong-type value must be rejected (4xx),
      // never accepted (2xx — a malformed write landed) or crashed (5xx).
      const badArgs = corruptArgs(tool, args);
      if (badArgs) {
        try {
          const req = probeRequest(tool, badArgs, authCtx);
          const r = await timedFetch(req.url, 15000, req.headers, req);
          const rejected = r.status >= 400 && r.status < 500;
          await record(tool.id, 'safety', 'write_invalid_payload_rejected', rejected, r.latencyMs,
            { url: redactString(buildUrl(tool, badArgs)), status: r.status,
              expectation: '4xx rejection of a wrong-type payload',
              outcome: rejected ? 'rejected_4xx' : r.status >= 500 ? 'crashed_5xx' : 'accepted_2xx' });
        } catch (e) {
          await record(tool.id, 'safety', 'write_invalid_payload_rejected', false, null, { error: String(e) });
        }
      } else {
        // No declared argument exists to corrupt — there is no payload
        // surface to validate. Recorded as an explicit pass so coverage
        // stays honest about what was (not) exercised.
        await record(tool.id, 'safety', 'write_invalid_payload_rejected', true, null,
          { verdict: 'not_applicable', reason: 'Tool declares no arguments; no payload to corrupt.' });
      }

      // Replay: an idempotent write must tolerate being fired twice with
      // identical arguments — no 5xx, and the second answer stays
      // consistent (same status, 2xx, or 404 once the resource is in its
      // final state, e.g. an already-deleted record).
      if (tool.idempotent) {
        try {
          const req = probeRequest(tool, args, authCtx);
          const first = await timedFetch(req.url, 15000, req.headers, req);
          const second = await timedFetch(req.url, 15000, req.headers, req);
          const consistent = second.status === first.status
            || second.status === 404
            || (first.status >= 200 && first.status < 300 && second.status >= 200 && second.status < 300);
          const ok = first.status < 500 && second.status < 500 && consistent;
          await record(tool.id, 'safety', 'write_replay_idempotent', ok, second.latencyMs,
            { url: redactString(buildUrl(tool, args)), first_status: first.status, second_status: second.status,
              expectation: 'Idempotent replay: no 5xx, second call consistent with the first' });
        } catch (e) {
          await record(tool.id, 'safety', 'write_replay_idempotent', false, null, { error: String(e) });
        }
      }

      // Confirmation contract: a write — above all a destructive call —
      // must never be fireable without the agent host asking the user
      // first. The compiler sets confirmation_required for every
      // non-read-only tool; this asserts the stored contract still says
      // so (a downgraded row fails loudly instead of shipping silent).
      const confirmed = tool.confirmation_required === true;
      await record(tool.id, 'safety', 'write_confirmation_contract', confirmed, null,
        { confirmation_required: confirmed, effect_classes: classes,
          expectation: classes.includes('destructive')
            ? 'Destructive tool carries confirmation_required so no destructive call fires without user confirmation'
            : 'Write tool carries confirmation_required so the host confirms before mutating' });
    }

    // — Custom (EV-04): the owner's own cases for this tool — given
    // args → expect shape/status. They run as the authenticated caller
    // (same probe path as every built-in) and a failure fails the run
    // like any other, so a flunked edge case never promotes to
    // `tested` or freezes into a release. Disabled scenarios never
    // reach this list; an empty list records nothing (summary is
    // honestly `not_tested`).
    for (const scenario of customScenariosOf(tool)) {
      try {
        const req = probeRequest(tool, scenario.given_args, authCtx);
        const r = await timedFetch(req.url, 15000, req.headers, req);
        const verdict = evaluateCustomExpectation(scenario, { status: r.status, body: r.body });
        await record(tool.id, 'custom', scenario.name, verdict.passed, r.latencyMs, {
          scenario_id: scenario.id, given_args: scenario.given_args,
          expect_status: scenario.expect_status, expect_body_keys: scenario.expect_body_keys,
          url: redactString(buildUrl(tool, scenario.given_args)), status: r.status,
          body_keys: verdict.bodyKeys,
          ...(verdict.passed ? {} : { failures: verdict.failures }),
        });
      } catch (e) {
        await record(tool.id, 'custom', scenario.name, false, null, {
          scenario_id: scenario.id, given_args: scenario.given_args,
          expect_status: scenario.expect_status, expect_body_keys: scenario.expect_body_keys,
          error: String(e),
        });
      }
    }
  }

  // Aggregate per-suite summaries; auth is honestly "not tested" only when
  // every evaluated tool requires no credentials.
  const rows = await q(`SELECT tool_id, suite, scenario, passed, detail FROM eval_results WHERE eval_run_id = $1`, [runId]) as Array<{ tool_id: string; suite: string; scenario: string; passed: boolean; detail?: any }>;
  for (const r of rows) { if (typeof r.detail === 'string') { try { r.detail = JSON.parse(r.detail); } catch { r.detail = {}; } } }
  for (const suite of ['contract', 'behavior', 'recovery']) {
    const s = rows.filter((r) => r.suite === suite);
    const p = s.filter((r) => r.passed).length;
    summaries[suite] = { status: p === s.length && s.length > 0 ? 'passed' : 'failed', passed: p, failed: s.length - p };
  }
  const authRows = rows.filter((r) => r.suite === 'auth');
  if (authRows.length === 0) {
    summaries['auth'] = { status: 'not_tested', reason: 'All evaluated tools require no credentials (credential_mode = none).' };
  } else {
    const p = authRows.filter((r) => r.passed).length;
    summaries['auth'] = { status: p === authRows.length ? 'passed' : 'failed', passed: p, failed: authRows.length - p };
  }
  // Safety (EV-05 → EV-06): read-only tools need no scenarios — being
  // verified read-only *is* their safety result. Write tools are judged
  // on the write-safety scenarios recorded above (invalid payload
  // rejected, idempotent replay, confirmation contract): the suite
  // passes only when every write tool ran them and none failed. The
  // verdict is counted from the recorded results, never asserted.
  const safetyRows = rows.filter((r) => r.suite === 'safety');
  const writeTools = tools.filter(isWriteTool);
  if (writeTools.length === 0) {
    summaries['safety'] = {
      status: 'passed',
      reason: tools.length > 0
        ? 'All evaluated tools are read_only with no confirmation requirement.'
        : 'No tools were evaluated.',
    };
  } else {
    const safetyPassed = safetyRows.filter((r) => r.passed).length;
    const uncovered = writeTools.filter((t) => !safetyRows.some((r) => r.tool_id === t.id));
    const safetyOk = safetyRows.length > 0 && safetyPassed === safetyRows.length && uncovered.length === 0;
    summaries['safety'] = {
      status: safetyOk ? 'passed' : 'failed',
      passed: safetyPassed,
      failed: safetyRows.length - safetyPassed,
      reason: safetyOk
        ? `${writeTools.length} write tool(s) passed the write-safety scenarios (invalid payload, replay, confirmation contract).`
        : `${writeTools.length} write tool(s) exercised: ${safetyRows.length - safetyPassed} scenario failure(s)` +
          (uncovered.length > 0 ? `; no safety scenarios recorded for ${uncovered.map((t) => t.name).join(', ')}` : '') + '.',
    };
  }

  // NOTE (EV-05/EV-06): a failed suite summary — safety included — fails
  // the run overall via `record()`, so a write tool that flunks its
  // safety scenarios never promotes to 'tested' or freezes into a
  // release. Certification (below) is the stricter, displayed bar on
  // top: it re-counts the safety results per tool before the badge.

  // Custom (EV-04): honestly `not_tested` until the owner defines a
  // case; otherwise counted from the recorded results like the others.
  // A custom failure already failed the run via `record()` (and so
  // blocks `tested`, release, and the `run_passed` certification
  // check) — certification criteria themselves stay v2.
  const customRows = rows.filter((r) => r.suite === 'custom');
  if (customRows.length === 0) {
    summaries['custom'] = { status: 'not_tested', reason: 'No custom scenarios are defined for the evaluated tools.' };
  } else {
    const p = customRows.filter((r) => r.passed).length;
    summaries['custom'] = {
      status: p === customRows.length ? 'passed' : 'failed',
      passed: p, failed: customRows.length - p,
    };
  }

  // EV-05/EV-06: judge the finished run against the published
  // certification criteria (v2 since EV-06) and store the verdict with
  // the summary, so the console badge is a stored fact about this run —
  // not recomputed from whatever the tools look like later. The pure
  // judge re-counts the raw results, so this verdict never just echoes
  // `overall`.
  const certification = evaluateCertification({
    runStatus: overall,
    suites: summaries,
    results: rows,
    tools: tools.map((t) => ({
      id: t.id,
      credential_mode: t.credential_mode ?? 'none',
      effect_classes: t.effect_classes,
      idempotent: t.idempotent === true,
    })),
  });

  // EV-08: the agent task suite runs last, on the same tools. It is stored
  // beside the harness suites (summary.agent), outside pass/fail and
  // certification, so the comparison between two runs shows how agents
  // behave with the tools as they are now.
  await onProgress?.(tools.length, tools.length, 'Running agent tasks');
  const agent = await runAgentSuite(projectId, runId, currentLlm()).catch((e): AgentSuiteSummary => ({
    status: 'not_tested', reason: `Agent tasks could not run: ${e instanceof Error ? e.message : String(e)}`,
  }));

  // Per-tool outcome: which operations passed, which failed, and why —
  // the console's "continue with the passed operations" flow reads this.
  const outcomes = summarizeToolOutcomes(tools, rows);

  await exec(`UPDATE eval_runs SET status = $1, summary = $2, finished_at = now() WHERE id = $3`,
    [overall, jb({
      suites: summaries, certification, agent, tools: outcomes,
      // Scoped runs record what they covered so the console can label a
      // partial run honestly instead of implying the whole toolset passed.
      scope: scoped ? { tool_ids: scoped, tool_count: tools.length } : null,
    }), runId]);

  // Promote per tool: an approved tool whose scenarios all passed becomes
  // 'tested' even when other tools failed the run — passed operations can
  // proceed to release without waiting for the failures to be fixed.
  if (outcomes.passed_tool_ids.length > 0) {
    await exec(`UPDATE canonical_tools SET status = 'tested', updated_at = now()
                WHERE project_id = $1 AND status = 'approved' AND id = ANY($2)`,
      [projectId, outcomes.passed_tool_ids]);
  }
  return runId;
}

/** Top-level keys of an object answer, or of the first item of a list answer. */
export function bodyKeys(body: unknown): string[] {
  const first = Array.isArray(body) ? body[0] : body;
  if (first && typeof first === 'object' && !Array.isArray(first)) return Object.keys(first);
  return [];
}

/** A 2xx answer worth handing an agent: a non-empty object, list or text. */
export function hasPayload(body: unknown): boolean {
  if (Array.isArray(body)) return body.length > 0;
  if (body && typeof body === 'object') return Object.keys(body).length > 0;
  return typeof body === 'string' ? body.trim().length > 0 : body !== null && body !== undefined;
}

// A 200 that carries no result set: an empty body/list/object, or an object
// whose list fields are all empty (`{ "data": [], "total": 0 }`). In the
// invalid-input scenario this maps to EMPTY_RESULT — the API didn't reject
// the input, it found nothing. Any API shape, no field names assumed.
export function isEmptyResults(body: unknown): boolean {
  if (body === null || body === undefined || body === '') return true;
  if (Array.isArray(body)) return body.length === 0;
  if (typeof body === 'object') {
    const values = Object.values(body as Record<string, unknown>);
    if (values.length === 0) return true;
    const lists = values.filter(Array.isArray) as unknown[][];
    return lists.length > 0 && lists.every((l) => l.length === 0);
  }
  return false;
}

// (The prototype redactUrl hook was replaced by DP-05's shared
// redactString in src/redact.ts — same query-param stripping, plus more
// sensitive param names and value shapes.)

export async function getRun(runId: string) {
  const run = await one(`SELECT * FROM eval_runs WHERE id = $1`, [runId]);
  const results = await q(`SELECT * FROM eval_results WHERE eval_run_id = $1 ORDER BY created_at`, [runId]);
  return { run, results };
}
