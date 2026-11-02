// Data-plane runtime (components 14–24).
// Serves ONLY pinned, signed releases: verify integrity → translate args →
// call upstream → normalize → redact → audit + telemetry → agent-safe result.
// The control plane is never on this hot path (release snapshots are frozen).

import { createHmac, timingSafeEqual } from 'node:crypto';
import { one, q, exec, J, uid, audit } from './db.js';
import {
  buildPage, keysetClause, type Cursor, DEFAULT_LIMIT,
} from './paginate.js';
import { checkInvokeRateLimit, type RateLimitDecision } from './rate-limit.js';
import { redactString, redactValue } from './redact.js';
import { resolveLease, resolveProjectTenant, injectionFor, applyInjection } from './broker/index.js';
import { isChannelAlias, resolveChannelRelease } from './release.js';
import { assembleUpstreamRequest, setHeader, upstreamUrl } from './upstream-request.js';
import { fetchWithEgress, EgressError } from './egress.js';
import { storablePrompt, type Attribution } from './attribution.js';

const SIGNING_SECRET = process.env.CF_SIGNING_SECRET ?? 'dev-only-signing-secret';

export interface InvokeRequest {
  project_id: string;
  version: string;       // pinned release version
  tool_name: string;
  args: Record<string, unknown>;
  prompt_ref?: string;   // opaque caller reference for attribution (no PII)
  client_ip?: string;    // BE-07: caller IP for the per-IP rate-limit bucket
  rate_limit_checked?: boolean; // BE-07: HTTP layer already charged the limiter — don't double-count
  actor?: string;        // DP-07: telemetry actor (`api-key:<prefix>` for gateway-key invokes)
  attribution?: Attribution; // D-89: channel / client / trigger / session / prompt
}

export interface InvokeResult {
  ok: boolean;
  tool: string;
  release_version: string;
  result?: unknown;
  error?: { condition: string; message: string };
  latency_ms: number;
}

export function verifySignature(version: string, bundleHash: string, signature: string): boolean {
  const expected = createHmac('sha256', SIGNING_SECRET).update(`${version}:${bundleHash}`).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature ?? '', 'utf8');
  // SE-11 (SE-06 F-11): constant-time comparison. timingSafeEqual throws
  // on length mismatch — the expected length is not secret (hex
  // HMAC-SHA256 is always 64 chars), so the length check goes first.
  return a.length === b.length && timingSafeEqual(a, b);
}

// ─── DP-06: upstream timeout + circuit breaker ─────────────────────────────
// The data plane calls customer upstreams it does not control. A slow or
// failing upstream must not hang every invoke or hammer a struggling API:
// each call has a hard timeout, and consecutive upstream-health failures
// (timeout, network error, 5xx) trip a per-upstream breaker. While open,
// invokes fail fast with UPSTREAM_CIRCUIT_OPEN without touching the
// upstream; after the cooldown a single half-open probe decides — success
// closes the breaker (recovery is automatic), failure re-opens it.
// Per-request answers (2xx–4xx, incl. 429) prove the upstream is alive and
// never trip the breaker; 429 keeps its RATE_LIMITED recovery-rule mapping.

function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** Per-call upstream timeout (ms). Read per invoke so ops/tests can tune it. */
export function resolveUpstreamTimeoutMs(): number {
  return envInt('CF_UPSTREAM_TIMEOUT_MS', 20_000);
}

export interface BreakerSnapshot {
  state: 'closed' | 'open' | 'half_open';
  consecutive_failures: number;
  opened_at: number | null;
}

export class UpstreamCircuitBreaker {
  private state: 'closed' | 'open' | 'half_open' = 'closed';
  private consecutiveFailures = 0;
  private openedAt: number | null = null;
  private probeInFlight = false;

  constructor(
    private readonly failureThreshold = envInt('CF_CIRCUIT_FAILURE_THRESHOLD', 5),
    private readonly cooldownMs = envInt('CF_CIRCUIT_COOLDOWN_MS', 30_000),
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Gate an invoke. Entering half-open claims the single probe slot. */
  canRequest(): boolean {
    if (this.state === 'closed') return true;
    if (this.state === 'open') {
      if (this.openedAt != null && this.now() - this.openedAt >= this.cooldownMs) {
        this.state = 'half_open';
        this.probeInFlight = true;
        return true;
      }
      return false;
    }
    // half_open: only the probe already in flight may proceed.
    if (this.probeInFlight) return false;
    this.probeInFlight = true;
    return true;
  }

  recordSuccess(): void {
    this.state = 'closed';
    this.consecutiveFailures = 0;
    this.openedAt = null;
    this.probeInFlight = false;
  }

  recordFailure(): void {
    this.probeInFlight = false;
    this.consecutiveFailures += 1;
    if (this.state === 'half_open' || this.consecutiveFailures >= this.failureThreshold) {
      this.state = 'open';
      this.openedAt = this.now();
    }
  }

  snapshot(): BreakerSnapshot {
    return { state: this.state, consecutive_failures: this.consecutiveFailures, opened_at: this.openedAt };
  }
}

// One breaker per upstream origin, shared across invokes in this process.
// (In the Lambda split each runtime instance keeps its own — acceptable:
// the breaker is a fail-fast guard, not a coordination primitive.)
const breakers = new Map<string, UpstreamCircuitBreaker>();

export function breakerFor(baseUrl: string): UpstreamCircuitBreaker {
  let key = baseUrl;
  try { key = new URL(baseUrl).origin; } catch { /* keep the raw base as key */ }
  let b = breakers.get(key);
  if (!b) { b = new UpstreamCircuitBreaker(); breakers.set(key, b); }
  return b;
}

/** Test hook: drop all breakers so cases start from a closed state. */
export function resetUpstreamBreakers(): void {
  breakers.clear();
}

export async function invoke(req: InvokeRequest): Promise<InvokeResult> {
  const start = Date.now();
  // RL-07: when the caller pins a channel alias (`staging`/`prod`), the
  // answer reports the version actually served, not the alias.
  let servedVersion = req.version;
  const finish = async (partial: Omit<InvokeResult, 'latency_ms'>, status: string, toolId?: string, releaseId?: string) => {
    const latencyMs = Date.now() - start;
    const a = req.attribution;
    await exec(
      `INSERT INTO telemetry_events (id, project_id, release_id, tool_id, tool_name, status, latency_ms, prompt_ref, actor,
         channel, client, trigger, trigger_source, session_id, turn_id, prompt_text)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
         CASE WHEN (SELECT capture_prompts FROM projects WHERE id = $2) THEN $16::text END)`,
      [uid(), req.project_id, releaseId ?? null, toolId ?? null, req.tool_name, status, latencyMs,
        // DP-05: prompt_ref is caller-supplied and lands in telemetry —
        // pattern-redact it so an email/token pasted here never persists.
        req.prompt_ref ? redactString(req.prompt_ref) : null,
        // DP-07: actor is server-derived (`api-key:<prefix>` or null) —
        // prefixes are display-safe by construction, never key material.
        req.actor ?? null,
        // D-89: attribution. A direct REST invoke with no declared context is
        // a script or job calling the API — automated.
        a?.channel ?? 'rest', a?.client ?? null,
        a?.trigger ?? (req.actor ? 'automated' : 'unknown'), a?.trigger_source ?? 'inferred',
        a?.session_id ?? null, a?.turn_id ?? null,
        // Prompt text only when the project opted in (the CASE above).
        storablePrompt(a?.prompt)]);
    return { ...partial, release_version: servedVersion, latency_ms: latencyMs };
  };

  // BE-07: rate limiting is the FIRST data-plane gate. A rejected invoke
  // costs no release lookup and never reaches the upstream; other projects
  // and other client IPs keep their own windows and are unaffected. The
  // HTTP layer (routes/workflow.ts) applies the same limits earlier
  // still — IP bucket pre-authorization, project bucket after the role
  // check (SE-09) — and passes rate_limit_checked so an admitted
  // request is charged exactly once; a request whose limiter trips
  // between the two checks (concurrent burst) is still refused here.
  // This combined gate remains for direct invoke() callers, where no
  // HTTP role check has run.
  const rl: RateLimitDecision | null = req.rate_limit_checked
    ? null
    : checkInvokeRateLimit(req.project_id, req.client_ip ?? 'unknown');
  if (rl && !rl.allowed) {
    await audit(req.project_id, 'runtime.invoke.rate_limited', 'project', undefined,
      { tool: req.tool_name, version: req.version, bucket: rl.bucket, limit: rl.limit });
    return finish({ ok: false, tool: req.tool_name, release_version: req.version,
      error: { condition: 'RATE_LIMITED',
        message: `Rate limit exceeded for this ${rl.bucket === 'project' ? 'project' : 'client'} (${rl.limit} invokes per window). Try again after ${new Date(rl.reset_at).toISOString()}.` } },
      'rate_limited');
  }

  // RL-07: a channel alias resolves to the newest approved release in that
  // channel; anything else is a pinned version (unchanged). An empty channel
  // is a plain, explainable refusal — staging traffic can never fall through
  // to whatever prod happens to serve.
  let pinnedVersion = req.version;
  if (isChannelAlias(req.version)) {
    const resolved = await resolveChannelRelease(req.project_id, req.version);
    if (!resolved) {
      return finish({ ok: false, tool: req.tool_name, release_version: req.version,
        error: { condition: 'RELEASE_CHANNEL_EMPTY',
          message: req.version === 'prod'
            ? 'No release has been promoted to prod for this project yet. Promote a staging release first.'
            : 'No approved release is staged for this project yet. Create and approve a release first.' } },
        'policy_blocked');
    }
    pinnedVersion = resolved.version;
  }

  const release = await one(`SELECT * FROM releases WHERE project_id = $1 AND version = $2`,
    [req.project_id, pinnedVersion]) as any;
  if (!release) {
    return finish({ ok: false, tool: req.tool_name, release_version: req.version,
      error: { condition: 'UNKNOWN_RELEASE', message: `No release ${req.version} for this project.` } }, 'policy_blocked');
  }
  servedVersion = release.version;
  // RL-06: a deprecated release is never served, even with a valid signature.
  // Point the caller at the previous approved release when one exists.
  if (release.status === 'deprecated') {
    const prev = await one(
      `SELECT version FROM releases WHERE project_id = $1 AND status = 'approved'
       ORDER BY created_at DESC, id DESC LIMIT 1`,
      [req.project_id]) as any;
    const why = release.deprecate_reason ? `: ${release.deprecate_reason}` : '';
    return finish({ ok: false, tool: req.tool_name, release_version: req.version,
      error: { condition: 'RELEASE_DEPRECATED',
        message: prev
          ? `Release ${req.version} was deprecated${why}. Use release ${prev.version} instead.`
          : `Release ${req.version} was deprecated${why}. No approved release remains for this project.` } },
      'policy_blocked', undefined, release.id);
  }
  if (!verifySignature(release.version, release.bundle_hash, release.signature)) {
    return finish({ ok: false, tool: req.tool_name, release_version: req.version,
      error: { condition: 'SIGNATURE_INVALID', message: 'Release signature verification failed. Refusing to serve.' } }, 'policy_blocked', undefined, release.id);
  }

  const row = await one(`SELECT tool_snapshot FROM release_tools rt
                         JOIN releases r ON r.id = rt.release_id
                         WHERE r.id = $1 AND rt.tool_snapshot->>'name' = $2`,
    [release.id, req.tool_name]) as any;
  if (!row) {
    return finish({ ok: false, tool: req.tool_name, release_version: req.version,
      error: { condition: 'UNKNOWN_TOOL', message: `Tool "${req.tool_name}" is not in release ${req.version}.` } }, 'policy_blocked', undefined, release.id);
  }
  const tool = J.parse<any>(row.tool_snapshot, {});
  const up = tool.upstream ?? {};

  // AB-05: credential requirements are enforced on the data plane, not
  // discovered from an upstream 401. AB-02 turns the api_key refusal into a
  // broker resolution at this exact site: the gates that refused now
  // resolve, with no parallel code path. The oauth refusal stays
  // byte-identical until AB-03. The material lives only in this function's
  // scope — never in the release snapshot (only the mode is), never in
  // telemetry, never in audit metadata.
  const credMode = typeof tool.credential_mode === 'string' ? tool.credential_mode : 'none';
  let leaseMaterial: string | null = null;
  if (credMode !== 'none' && credMode !== 'api_key') {
    await audit(req.project_id, 'runtime.invoke.credential_required', 'tool', undefined,
      { tool: req.tool_name, version: req.version, credential_mode: credMode });
    return finish({ ok: false, tool: req.tool_name, release_version: req.version,
      error: { condition: 'CREDENTIAL_REQUIRED',
        message: credMode === 'oauth'
          ? `Tool "${req.tool_name}" requires OAuth, but no account is connected for this project. Connect an account and try again.`
          : `Tool "${req.tool_name}" requires an API key, but no credential is configured for this project. Add a credential and try again.` } },
      'policy_blocked', undefined, release.id);
  }
  if (credMode === 'api_key') {
    // Server-side selection: the request never names a handle. The tenant
    // comes from the server's own project lookup, never caller input.
    const tenant = await resolveProjectTenant(req.project_id);
    const lease = await resolveLease({ tenant, projectId: req.project_id, scopes: [], purpose: 'invoke' });
    if (!lease.ok) {
      await audit(req.project_id, 'runtime.invoke.credential_required', 'tool', undefined,
        { tool: req.tool_name, version: req.version, credential_mode: credMode });
      return finish({ ok: false, tool: req.tool_name, release_version: req.version,
        error: { condition: 'CREDENTIAL_REQUIRED',
          message: `Tool "${req.tool_name}" requires an API key, but no credential is configured for this project. Add a credential and try again.` } },
        'policy_blocked', undefined, release.id);
    }
    leaseMaterial = lease.material;
  }

  // Translate args → upstream request. BE-16: assembly is shared with eval
  // (src/upstream-request.ts) — path/query substitution, body fields → one
  // JSON body, and the tool's real HTTP method. BE-17: header/cookie params
  // are part of the assembly now. (Fetch used to run with its GET default
  // and no body at all, so every compiled POST/PUT tool called the wrong
  // method with an empty payload.)
  const assembled = assembleUpstreamRequest(up, req.args);
  const headers: Record<string, string> = { ...assembled.headers };
  // AB-02: inject the leased key per the tool's frozen scheme (header
  // bearer/key, basic, cookie, query) into these same maps, BEFORE the URL
  // is finalized — so on any collision with a caller-supplied header/cookie
  // param the credential wins (BE-17 precedence). Missing scheme details in
  // pre-AB-02 snapshots fall back to the X-API-Key default (D-35).
  if (leaseMaterial !== null) {
    const inj = injectionFor(tool);
    if (inj) applyInjection(headers, assembled.query, leaseMaterial, inj);
  }
  // Our default agent string yields to a spec-declared User-Agent param.
  if (!Object.keys(headers).some((k) => k.toLowerCase() === 'user-agent')) {
    headers['user-agent'] = 'connector-foundry-runtime/0.1';
  }
  const url = upstreamUrl(String(up.base_url ?? ''), assembled.path, assembled.query);

  // DP-06: fail fast while this upstream's breaker is open.
  const breaker = breakerFor(String(up.base_url ?? ''));
  if (!breaker.canRequest()) {
    await audit(req.project_id, 'runtime.invoke.circuit_open', 'tool', undefined,
      { tool: req.tool_name, version: req.version, upstream: up.base_url });
    return finish({ ok: false, tool: req.tool_name, release_version: req.version,
      error: { condition: 'UPSTREAM_CIRCUIT_OPEN',
        message: 'The upstream API is temporarily unavailable after repeated failures. Try again shortly.' } },
      'upstream_error', undefined, release.id);
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), resolveUpstreamTimeoutMs());
  try {
    if (assembled.hasBody) setHeader(headers, 'content-type', 'application/json');
    // SE-08: upstream fetches go through the shared egress policy —
    // scheme allowlist, private/loopback/link-local rejection (per
    // redirect hop), response-size cap — never bare fetch.
    const res = await fetchWithEgress(url, {
      method: assembled.method,
      signal: ctrl.signal,
      headers,
      ...(assembled.hasBody ? { body: JSON.stringify(assembled.body) } : {}),
    });
    clearTimeout(timer);
    const text = await res.text();
    let body: unknown = text;
    try { body = JSON.parse(text); } catch { /* keep text */ }

    // Breaker health: 5xx is an upstream-health failure; any other HTTP
    // answer proves the upstream is alive and closes/resets the breaker.
    if (res.status >= 500) breaker.recordFailure(); else breaker.recordSuccess();

    if (res.status >= 200 && res.status < 300) {
      const result = normalize(body);
      await audit(req.project_id, 'runtime.invoke.ok', 'tool', undefined,
        { tool: req.tool_name, version: req.version, status: res.status });
      return finish({ ok: true, tool: req.tool_name, release_version: req.version, result }, 'ok', undefined, release.id);
    }

    // Map upstream failure to a recovery rule
    const condition = res.status === 429 ? 'RATE_LIMITED' : res.status >= 500 ? 'UPSTREAM_ERROR' : 'BAD_REQUEST';
    const rule = (tool.recovery_rules ?? []).find((r: any) => r.condition === condition);
    await audit(req.project_id, 'runtime.invoke.upstream_error', 'tool', undefined,
      { tool: req.tool_name, version: req.version, status: res.status, condition });
    return finish({ ok: false, tool: req.tool_name, release_version: req.version,
      error: { condition, message: rule?.user_message ?? `Upstream returned ${res.status}.` } }, 'upstream_error', undefined, release.id);
  } catch (e) {
    clearTimeout(timer);
    // SE-08: an egress-policy refusal (private/loopback target, blocked
    // redirect hop, oversized response) is a policy block, not an
    // upstream-health signal — it never trips the breaker (DP-06).
    if (e instanceof EgressError) {
      await audit(req.project_id, 'runtime.invoke.egress_blocked', 'tool', undefined,
        { tool: req.tool_name, version: req.version, reason: e.reason });
      return finish({ ok: false, tool: req.tool_name, release_version: req.version,
        error: { condition: 'EGRESS_BLOCKED', message: e.message } },
        'policy_blocked', undefined, release.id);
    }
    // Timeout (our AbortController fired) is distinct from unreachable, and
    // both are upstream-health failures for the breaker (DP-06).
    breaker.recordFailure();
    const timedOut = e instanceof Error && e.name === 'AbortError';
    await audit(req.project_id, 'runtime.invoke.error', 'tool', undefined,
      { tool: req.tool_name, error: String(e), timed_out: timedOut });
    return finish({ ok: false, tool: req.tool_name, release_version: req.version,
      error: timedOut
        ? { condition: 'UPSTREAM_TIMEOUT', message: 'The upstream API did not respond in time. Try again shortly.' }
        : { condition: 'UPSTREAM_UNREACHABLE', message: 'Could not reach the API. Try again shortly.' } },
      'upstream_error', undefined, release.id);
  }
}

// Normalize: keep JSON as-is; truncate long strings; DP-05 redaction
// (src/redact.ts) strips secret-shaped fields AND PII/secret value shapes
// (emails, tokens, card numbers, …) before the result is returned or
// anything derived from it is logged.
function normalize(body: unknown): unknown {
  return redactValue(body);
}

// TE-02: telemetry retention. A plan keeps 3/6/12 months of telemetry
// (`plans.telemetry_retention_days` — packaging as data: trial 30, Starter
// 90, Growth 180, Scale 365). The architecture caps lookback at 12 months
// (`MAX_LOOKBACK_HOURS`) even for plans whose retention could grow beyond
// it later. The API never errors on an over-long window: it clamps and says
// so (`retention.locked`), so the console can render the locked state with
// an upgrade nudge instead of a failure.
export const MAX_LOOKBACK_HOURS = 365 * 24;

export interface RetentionInfo {
  /** The owning plan's retention in days; null when the project has no
   *  customer/plan row (legacy rows) — then only the architecture cap binds. */
  retention_days: number | null;
  requested_hours: number;
  effective_hours: number;
  /** True when the request wanted more history than the plan (or the
   *  architecture cap) allows — the console's "locked" state. */
  locked: boolean;
}

/** Clamp a requested lookback to the plan's retention and the architecture cap. */
export function resolveWindowHours(requestedHours: number, retentionDays?: number | null): RetentionInfo {
  const retentionCap = retentionDays == null ? MAX_LOOKBACK_HOURS : retentionDays * 24;
  const effective_hours = Math.max(1, Math.min(requestedHours, retentionCap, MAX_LOOKBACK_HOURS));
  return {
    retention_days: retentionDays ?? null,
    requested_hours: requestedHours,
    effective_hours,
    locked: effective_hours < requestedHours,
  };
}

// BE-08: the recent-events list is keyset-paginated ((created_at, id) newest
// first); the aggregate panels are not paged. Callers pass limit + cursor
// from the parsed query; the returned `pagination` describes the `recent` page.
// TE-02: `retentionDays` (from the project's plan) clamps every panel —
// aggregates AND the recent list — so no panel ever serves history the plan
// doesn't keep. The clamped window is reported back as `retention`.
export async function telemetrySummary(
  projectId: string,
  hours = 336,
  page?: { limit?: number; cursor?: Cursor | null },
  retentionDays?: number | null,
) {
  const retention = resolveWindowHours(hours, retentionDays);
  const windowHours = retention.effective_hours;
  // Cast aggregates: pg returns COUNT/AVG as strings otherwise.
  const byStatus = await q(
    `SELECT status, COUNT(*)::int AS n, AVG(latency_ms)::float AS avg_ms
     FROM telemetry_events
     WHERE project_id = $1 AND created_at >= now() - ($2 * interval '1 hour')
     GROUP BY status`,
    [projectId, windowHours]);
  const limit = page?.limit ?? DEFAULT_LIMIT;
  const { clause, params } = keysetClause({
    cursor: page?.cursor ?? null, direction: 'DESC', keyCol: 'created_at', idCol: 'id', paramStart: 3,
  });
  const recentRows = await q(
    `SELECT tool_name, status, latency_ms, prompt_ref, created_at, id,
            channel, client, trigger, trigger_source, session_id, turn_id, prompt_text,
            (SELECT version FROM releases r WHERE r.id = telemetry_events.release_id) AS release_version
     FROM telemetry_events
     WHERE project_id = $1 AND created_at >= now() - ($2 * interval '1 hour')${clause}
     ORDER BY created_at DESC, id DESC LIMIT $${params.length + 3}`,
    [projectId, windowHours, ...params, limit + 1]);
  const recentPage = buildPage(recentRows as Record<string, any>[], limit, 'created_at', 'id');
  const byTool = await q(
    `SELECT tool_name, COUNT(*)::int AS calls,
            SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END)::int AS ok_calls,
            AVG(latency_ms)::float AS avg_ms
     FROM telemetry_events WHERE project_id = $1 AND created_at >= now() - ($2 * interval '1 hour')
     GROUP BY tool_name`,
    [projectId, windowHours]);
  // D-89: who and what drives the calls. Each breakdown is one GROUP BY
  // over the same window; NULL buckets (calls recorded before attribution
  // existed) read as 'unknown'.
  const breakdown = (col: string) => q(
    `SELECT COALESCE(${col}, 'unknown') AS key, COUNT(*)::int AS calls,
            SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END)::int AS ok_calls,
            AVG(latency_ms)::float AS avg_ms
       FROM telemetry_events
      WHERE project_id = $1 AND created_at >= now() - ($2 * interval '1 hour')
      GROUP BY 1 ORDER BY calls DESC`,
    [projectId, windowHours]);
  const [byTrigger, byClient, byChannel] = await Promise.all([
    breakdown('trigger'), breakdown('client'), breakdown('channel'),
  ]);
  const byRelease = await q(
    `SELECT COALESCE(r.version, 'unreleased') AS key, COUNT(*)::int AS calls,
            SUM(CASE WHEN t.status = 'ok' THEN 1 ELSE 0 END)::int AS ok_calls,
            AVG(t.latency_ms)::float AS avg_ms
       FROM telemetry_events t LEFT JOIN releases r ON r.id = t.release_id
      WHERE t.project_id = $1 AND t.created_at >= now() - ($2 * interval '1 hour')
      GROUP BY 1 ORDER BY 1`,
    [projectId, windowHours]);
  const topPrompts = await q(
    `SELECT prompt_text AS prompt, COUNT(*)::int AS calls,
            COUNT(DISTINCT COALESCE(turn_id, id))::int AS turns,
            MAX(created_at) AS last_seen_at
       FROM telemetry_events
      WHERE project_id = $1 AND created_at >= now() - ($2 * interval '1 hour') AND prompt_text IS NOT NULL
      GROUP BY prompt_text ORDER BY calls DESC LIMIT 10`,
    [projectId, windowHours]);
  const capture = await one<any>(`SELECT capture_prompts FROM projects WHERE id = $1`, [projectId]);
  return {
    by_status: byStatus, by_tool: byTool, recent: recentPage.items,
    by_trigger: byTrigger, by_client: byClient, by_channel: byChannel, by_release: byRelease,
    top_prompts: topPrompts, capture_prompts: Boolean(capture?.capture_prompts),
    pagination: recentPage.meta, retention,
  };
}
