import { Router } from 'express';
import { one, q, exec, audit, J } from '../db.js';
import { getRun, summarizeToolOutcomes } from '../eval.js';
import { evaluateCertification } from '../certification.js';
import { createRelease, approveRelease, getManifest, rollbackRelease, promoteRelease, promotionReadiness } from '../release.js';
import { renderStdioBridgeScript } from '../mcp.js';
import { invoke, telemetrySummary } from '../runtime.js';
import { invokeIpRateLimit, invokeProjectRateLimit, invokeKeyRateLimit, clientIpOf } from '../rate-limit.js';
import { requireAuth, requireProjectRole, requireProjectRead } from '../auth.js';
import { publicBaseUrl } from '../security.js';
import type { Trigger } from '../attribution.js';
import { diffSnapshots } from '../release-diff.js';
import { extractGatewayKey, authenticateGatewayKey, touchGatewayKey, gatewayActor } from '../gateway-keys.js';
import { validateBody, createReleaseSchema, approveReleaseSchema, rollbackReleaseSchema, promoteReleaseSchema, invokeSchema } from '../validate.js';
import { asyncHandler, HttpError } from '../errors.js';
import {
  renderEvalReportHtml, resolveReportStoreConfig, reportKeyFor, uploadReportHtml, presignedReportUrl,
} from '../report.js';
import {
  buildOpenAiTools, buildGptActionsOpenApi, loadReleaseSnapshots, validateGptActionsOpenApi, validateOpenAiTools,
} from '../openai-artifacts.js';
import { buildMuseKit } from '../muse-kit.js';
import {
  parsePagination, paginationError, keysetClause, buildPage,
} from '../paginate.js';

export const evalRouter = Router();

// NOTE: POST /v1/projects/:id/eval now enqueues a background job —
// see routes/jobs.ts. Evaluations run on the queue, not the request thread.

// BE-09: project reads are tenant-scoped — requireProjectRead 404s
// projects outside the caller's customers (any role may read).
evalRouter.get('/:id/eval/runs', requireProjectRead(), asyncHandler(async (req, res) => {
  const pg = parsePagination(req.query as Record<string, any>);
  if (!pg.ok) return paginationError(res, pg.fields);
  const { clause, params } = keysetClause({
    cursor: pg.cursor, direction: 'DESC', keyCol: 'started_at', idCol: 'id', paramStart: 2,
  });
  const runs = await q(
    `SELECT * FROM eval_runs WHERE project_id = $1${clause}
     ORDER BY started_at DESC, id DESC LIMIT $${params.length + 2}`,
    [req.params.id, ...params, pg.limit + 1],
  );
  const page = buildPage(runs as Record<string, any>[], pg.limit, 'started_at', 'id');
  res.json({
    runs: page.items.map((r: any) => ({ ...r, summary: J.parse(r.summary, {}) })),
    pagination: page.meta,
  });
}));

evalRouter.get('/eval/runs/:runId', requireProjectRead('evalRunParam'), asyncHandler(async (req, res) => {
  const { run, results } = await getRun(req.params.runId);
  if (!run) return res.status(404).json({ error: 'Eval run not found' });
  const parsedResults = (results as any[]).map((r) => ({ ...r, passed: Boolean(r.passed), detail: J.parse(r.detail, {}) }));
  const summary = J.parse((run as any).summary, {}) as Record<string, any>;
  // EV-05: runs finished after EV-05 carry a stored certification verdict.
  // Older runs are judged on read from their recorded results (against the
  // tools as they currently exist — the honest best available for legacy
  // runs) so the badge rules apply to history too.
  if (!summary.certification) {
    const toolRows = await q(
      `SELECT id, credential_mode, effect_classes, idempotent FROM canonical_tools WHERE project_id = $1`,
      [(run as any).project_id]);
    summary.certification = evaluateCertification({
      runStatus: (run as any).status,
      suites: summary.suites ?? {},
      results: parsedResults,
      tools: (toolRows as any[]).map((t) => ({
        id: t.id,
        credential_mode: t.credential_mode ?? 'none',
        effect_classes: J.parse(t.effect_classes, []),
        idempotent: t.idempotent === true,
      })),
    });
  }
  res.json({ run: { ...(run as any), summary }, results: parsedResults });
}));

// Passed-only flow: continue with the operations that passed this run and
// set the failures aside (back to candidate, so they leave the release set
// and stop blocking it). They stay visible with their failure categories;
// re-approving one re-includes it in the next evaluation.
evalRouter.post('/:id/eval/runs/:runId/keep-passed', requireProjectRole(['owner', 'editor']), asyncHandler(async (req, res) => {
  const { run, results } = await getRun(req.params.runId);
  if (!run || (run as any).project_id !== req.params.id) {
    return res.status(404).json({ error: 'Eval run not found' });
  }
  const summary = J.parse((run as any).summary, {}) as Record<string, any>;
  const toolRows = await q(`SELECT id, name, status FROM canonical_tools WHERE project_id = $1`, [req.params.id]) as any[];
  const outcomes = summary.tools ?? summarizeToolOutcomes(
    toolRows, (results as any[]).map((r) => ({ ...r, passed: Boolean(r.passed), detail: J.parse(r.detail, {}) })));
  const failedIds = new Set<string>((outcomes.failed_tools ?? []).map((t: any) => t.tool_id));
  const excluded = toolRows.filter((t) => failedIds.has(t.id) && t.status === 'approved');
  if (excluded.length > 0) {
    await exec(`UPDATE canonical_tools SET status = 'candidate', updated_at = now()
                WHERE project_id = $1 AND status = 'approved' AND id = ANY($2)`,
      [req.params.id, excluded.map((t) => t.id)]);
  }
  const kept = toolRows.filter((t) => (outcomes.passed_tool_ids ?? []).includes(t.id));
  await audit(req.params.id, 'eval.keep_passed', 'eval_run', req.params.runId,
    { kept: kept.length, excluded: excluded.length });
  res.json({
    total: outcomes.total, passed: outcomes.passed, failed: outcomes.failed,
    kept_tools: kept.map((t) => t.name), excluded_tools: excluded.map((t) => t.name),
    failures_by_category: outcomes.failures_by_category ?? [],
  });
}));

// EV-03: GET /v1/projects/:id/eval/runs/:runId/report — render the run as a
// self-contained HTML report and answer a download. With report storage
// configured (CF_REPORT_S3_BUCKET + AWS credentials) the HTML is stored in
// S3 and the answer is a short-lived signed URL; without it (local dev)
// the rendered HTML is answered inline and the console downloads it
// directly — Download report works everywhere. Tenant-scoped like every
// project read (BE-09); a run belonging to another project answers the same
// 404 as an unknown run.
evalRouter.get('/:id/eval/runs/:runId/report', requireProjectRead(), asyncHandler(async (req, res) => {
  const { run, results } = await getRun(req.params.runId);
  if (!run || (run as any).project_id !== req.params.id) {
    return res.status(404).json({ error: 'Eval run not found' });
  }
  const projectRows = await q(`SELECT name FROM projects WHERE id = $1`, [req.params.id]);
  const toolRows = await q(`SELECT id, name FROM canonical_tools WHERE project_id = $1`, [req.params.id]);
  const toolNames = new Map((toolRows as any[]).map((t) => [t.id, t.name]));
  const generatedAt = new Date();
  const html = renderEvalReportHtml({
    projectId: req.params.id,
    projectName: (projectRows[0] as any)?.name ?? req.params.id,
    run: { ...(run as any), summary: J.parse((run as any).summary, {}) },
    results: (results as any[]).map((r) => ({
      ...r,
      passed: Boolean(r.passed),
      detail: J.parse(r.detail, {}),
      tool_name: toolNames.get(r.tool_id) ?? r.tool_id,
    })),
    generatedAt,
  });
  const cfg = await resolveReportStoreConfig();
  if (!cfg) {
    // No report storage (local dev): answer the rendered HTML inline —
    // the console downloads it directly instead of failing with 503.
    return res.json({
      report: {
        run_id: req.params.runId,
        format: 'html',
        inline: true,
        html,
        expires_at: null,
        size_bytes: Buffer.byteLength(html),
      },
    });
  }
  const key = reportKeyFor(cfg, req.params.id, req.params.runId);
  try {
    await uploadReportHtml(cfg, key, html);
  } catch {
    // uploadReportHtml's message can carry an S3 error body — log-free here,
    // the client gets a clean retryable 502 either way (BE-05).
    throw new HttpError(502, 'report_upload_failed', 'Could not store the eval report — please try again');
  }
  const { url, expiresAt } = presignedReportUrl(cfg, key, generatedAt);
  res.json({
    report: {
      run_id: req.params.runId,
      format: 'html',
      url,
      expires_at: expiresAt.toISOString(),
      size_bytes: Buffer.byteLength(html),
    },
  });
}));

export const releasesRouter = Router();

// POST /v1/projects/:id/releases — {version} → freeze + sign + render (OUT-01)
releasesRouter.post('/:id/releases', requireProjectRole(['owner', 'editor']), validateBody(createReleaseSchema), asyncHandler(async (req, res) => {
  // createRelease throws HttpError (404/400/409) for domain failures — handled centrally.
  const { version, tool_ids } = req.body as { version: string; tool_ids?: string[] };
  const { id, manifest } = await createRelease(req.params.id, version,
    tool_ids ? { toolIds: tool_ids } : undefined);
  res.status(201).json({ release_id: id, version, manifest });
}));

// POST /v1/releases/:releaseId/approve — customer sign-off (GOV-01)
releasesRouter.post('/:releaseId/approve', requireProjectRole(['owner', 'editor'], 'releaseParam'), validateBody(approveReleaseSchema), asyncHandler(async (req, res) => {
  await approveRelease(req.params.releaseId, (req.body as any)?.approver ?? 'prototype-user');
  res.json({ ok: true });
}));

// POST /v1/releases/:releaseId/promote — RL-07: move an approved release
// between channels (staging → prod by default). Audit-logged; moving a
// release never touches its frozen snapshot.
releasesRouter.post('/:releaseId/promote', requireProjectRole(['owner', 'editor'], 'releaseParam'), validateBody(promoteReleaseSchema), asyncHandler(async (req, res) => {
  const actor = req.auth?.email ?? 'prototype-user';
  const { channel } = req.body as { channel?: 'staging' | 'prod' };
  res.json(await promoteRelease(req.params.releaseId, actor, channel ?? 'prod'));
}));

// GET /v1/releases/:releaseId/promotion-readiness — RL-08: the checklist a
// customer works through before prod promotion (what's missing + how to
// fix it). Prod promotion itself enforces the same readiness server-side.
releasesRouter.get('/releases/:releaseId/promotion-readiness', requireProjectRead('releaseParam'), asyncHandler(async (req, res) => {
  res.json(await promotionReadiness(req.params.releaseId));
}));

// POST /v1/releases/:releaseId/rollback — RL-06: deprecate a bad release in one action.
// Returns the previous approved release as the fallback target. Audit-logged.
releasesRouter.post('/:releaseId/rollback', requireProjectRole(['owner', 'editor'], 'releaseParam'), validateBody(rollbackReleaseSchema), asyncHandler(async (req, res) => {
  const actor = req.auth?.email ?? 'prototype-user';
  const { reason } = req.body as { reason?: string };
  res.json(await rollbackRelease(req.params.releaseId, actor, reason));
}));

releasesRouter.get('/:id/releases', requireProjectRead(), asyncHandler(async (req, res) => {
  const pg = parsePagination(req.query as Record<string, any>);
  if (!pg.ok) return paginationError(res, pg.fields);
  const { clause, params } = keysetClause({
    cursor: pg.cursor, direction: 'DESC', keyCol: 'created_at', idCol: 'id', paramStart: 2,
  });
  // SE-11 (SE-06 F-10): the list payload omits `signature` — the HMAC has
  // no client use (verification is server-side only) and BOPLA hygiene
  // keeps it out of reader-visible responses. The signed manifest stays
  // available via GET /:releaseId/manifest.
  const rows = await q(
    `SELECT id, version, bundle_hash, target, status, channel, promoted_at, promoted_by, approved_by, approved_at,
            deprecated_at, deprecated_by, deprecate_reason, created_at
     FROM releases WHERE project_id = $1${clause}
     ORDER BY created_at DESC, id DESC LIMIT $${params.length + 2}`,
    [req.params.id, ...params, pg.limit + 1],
  );
  const page = buildPage(rows as Record<string, any>[], pg.limit, 'created_at', 'id');
  res.json({ releases: page.items, pagination: page.meta });
}));

// GET /v1/releases/:releaseId/manifest — download the v1 release manifest (MCP + OpenAI artifacts)
// BE-09: the manifest is the full release artifact — scoped like every
// other project read (outsiders get the same 404 as an unknown release).
releasesRouter.get('/:releaseId/manifest', requireProjectRead('releaseParam'), asyncHandler(async (req, res) => {
  res.json(await getManifest(req.params.releaseId));
}));

// GET /v1/releases/:releaseId/changes[?against=<releaseId>] — what changed
// for agents since the previous release of the project (or `against`),
// plus each release's latest eval evidence, for the Publish screen's
// "v1 → v2" view.
releasesRouter.get('/:releaseId/changes', requireProjectRead('releaseParam'), asyncHandler(async (req, res) => {
  const rel = await one<any>(`SELECT id, project_id, version, created_at FROM releases WHERE id = $1`, [req.params.releaseId]);
  if (!rel) return res.status(404).json({ error: 'Release not found' });
  const against = typeof req.query.against === 'string' ? req.query.against : null;
  const base = against
    ? await one<any>(`SELECT id, version FROM releases WHERE id = $1 AND project_id = $2`, [against, rel.project_id])
    : await one<any>(
      `SELECT id, version FROM releases WHERE project_id = $1 AND created_at < $2 ORDER BY created_at DESC LIMIT 1`,
      [rel.project_id, rel.created_at]);
  const snapshots = async (id: string) => (await q<any>(
    `SELECT tool_snapshot FROM release_tools WHERE release_id = $1`, [id])).map((r) => J.parse<Record<string, any>>(r.tool_snapshot, {}));
  // A release's evidence is the project's last finished eval before it was cut.
  const evidence = async (id: string) => one<any>(
    `SELECT e.id, e.status, e.summary, e.finished_at FROM eval_runs e JOIN releases r ON r.id = $1
      WHERE e.project_id = r.project_id AND e.finished_at IS NOT NULL AND e.finished_at <= r.created_at
      ORDER BY e.finished_at DESC LIMIT 1`, [id]);
  res.json({
    release: { id: rel.id, version: rel.version },
    base: base ? { id: base.id, version: base.version } : null,
    changes: diffSnapshots(base ? await snapshots(base.id) : [], await snapshots(rel.id)),
    eval: { release: await evidence(rel.id) ?? null, base: base ? (await evidence(base.id)) ?? null : null },
  });
}));

// GET /v1/releases/:releaseId/mcp/stdio — RL-03 build-time artifact: a
// dependency-free Node stdio bridge forwarding to the hosted MCP server.
// The script reads the gateway key from the environment at runtime; no
// secret is ever written into the generated file.
releasesRouter.get('/:releaseId/mcp/stdio', requireProjectRead('releaseParam'), asyncHandler(async (req, res) => {
  const rows = await q(`SELECT project_id, version FROM releases WHERE id = $1`, [req.params.releaseId]);
  if (!rows.length) return res.status(404).json({ error: 'Release not found' });
  const { project_id, version } = rows[0] as any;
  const mcpUrl = `${publicBaseUrl(req)}/v1/mcp/${project_id}?version=${encodeURIComponent(version)}`;
  const script = renderStdioBridgeScript({ mcpUrl, projectId: String(project_id), version: String(version) });
  res
    .type('text/javascript')
    .set('Content-Disposition', `attachment; filename="connector-foundry-mcp-${String(version).replace(/[^A-Za-z0-9._-]/g, '_')}.mjs"`)
    .send(script);
}));

// GET /v1/releases/:releaseId/openai/tools — RL-04: the OpenAI
// function-calling tools array for this release, generated from the
// frozen snapshots. Self-checked against the function-calling contract
// before it leaves: a malformed artifact is a 500, never a bad download.
releasesRouter.get('/:releaseId/openai/tools', requireProjectRead('releaseParam'), asyncHandler(async (req, res) => {
  const rel = await loadReleaseSnapshots(req.params.releaseId);
  const tools = buildOpenAiTools(rel.snapshots);
  const issues = validateOpenAiTools(tools);
  if (issues.length > 0) {
    throw new HttpError(500, 'openai_artifact_invalid',
      `Generated OpenAI tools failed validation: ${issues.map((i) => `${i.path}: ${i.message}`).join('; ')}`);
  }
  res.json({ release_id: rel.releaseId, version: rel.version, tools });
}));

// GET /v1/releases/:releaseId/openai/actions — RL-04: the GPT Actions
// OpenAPI document for this release. Operations point at the gateway-key
// execution surface under this request's origin, so the document a
// customer pastes into the GPT editor works against the deployment that
// generated it.
releasesRouter.get('/:releaseId/openai/actions', requireProjectRead('releaseParam'), asyncHandler(async (req, res) => {
  const rel = await loadReleaseSnapshots(req.params.releaseId);
  const serverUrl = `${publicBaseUrl(req)}/v1/gpt-actions/${rel.projectId}/${encodeURIComponent(rel.version)}`;
  const doc = buildGptActionsOpenApi({
    connectorName: rel.connectorName,
    version: rel.version,
    description: rel.description,
    serverUrl,
  }, rel.snapshots);
  const issues = validateGptActionsOpenApi(doc);
  if (issues.length > 0) {
    throw new HttpError(500, 'gpt_actions_artifact_invalid',
      `Generated GPT Actions document failed validation: ${issues.map((i) => `${i.path}: ${i.message}`).join('; ')}`);
  }
  res.json(doc);
}));

// GET /v1/releases/:releaseId/muse/kit — HK-08/D-85: the Meta Muse
// submission kit for this release. Muse has no manifest spec or publish
// API — intake is a manual form whose preferred "Existing MCP" route
// points at our hosted MCP endpoint (RL-02) — so the kit is that
// endpoint plus the per-tool access classes, auth requirements, review
// gate result and a form checklist with prefilled values. The gate does
// not certify: it blocks money-movement, destructive and unconfirmed
// writes with a reason each.
releasesRouter.get('/:releaseId/muse/kit', requireProjectRead('releaseParam'), asyncHandler(async (req, res) => {
  const rel = await loadReleaseSnapshots(req.params.releaseId);
  const mcpEndpoint = `${publicBaseUrl(req)}/v1/mcp/${rel.projectId}?version=${encodeURIComponent(rel.version)}`;
  const kit = buildMuseKit({
    releaseId: rel.releaseId, version: rel.version, connectorName: rel.connectorName,
    description: rel.description, mcpEndpoint, snapshots: rel.snapshots,
  });
  res
    .type('application/json')
    .set('Content-Disposition', `attachment; filename="muse-connector-kit-${rel.version.replace(/[^A-Za-z0-9._-]/g, '_')}.json"`)
    .send(JSON.stringify(kit, null, 2));
}));

export const runtimeRouter = Router();

// POST /v1/runtime/invoke — data-plane tool invocation (real upstream call)
// SE-09 (was BE-07): the rate-limit charge is split around the role gate.
// invokeIpRateLimit runs FIRST (per-IP bucket only) so an abusive client
// gets a cheap 429 before any role-check DB work; the auth dispatcher
// then admits or rejects the caller; invokeProjectRateLimit charges the
// per-project bucket only for admitted callers, keyed on the
// role-checked project — an outsider naming a victim project can no
// longer burn the victim's quota. The handler passes
// rate_limit_checked so invoke()'s own gate doesn't double-charge the
// admitted request; invoke() still maps a RATE_LIMITED condition (its
// gate tripping for a direct caller) to HTTP 429 here.
//
// DP-07: the dispatcher (invokeAuth) accepts a project gateway key
// (`Authorization: Bearer cf_live_…` or `X-API-Key: cf_live_…`) in place
// of the human JWT + role gate — the key IS the project credential.
// Unknown/expired/revoked keys get one generic 401; a key presented for
// another project gets the outsider 404. Admitted key invokes also
// charge the per-key bucket (invokeKeyRateLimit) and record telemetry
// actor `api-key:<prefix>`.

/** Customer statuses that may write (BL-04 rule, as in customerWritable). */
const KEY_WRITABLE_STATUSES = new Set(['active', 'trialing', 'past_due']);

function invokeAuth(req: any, res: any, next: any): void {
  const presented = extractGatewayKey(req.headers ?? {});
  if (presented) {
    authenticateGatewayKey(presented)
      .then(async (key) => {
        if (!key) {
          return res.status(401).json({
            error: 'Invalid or expired API key', code: 'invalid_api_key', request_id: req.id ?? null,
          });
        }
        const bodyProject = typeof req.body?.project_id === 'string' ? req.body.project_id : null;
        if (bodyProject && bodyProject !== key.project_id) {
          return res.status(404).json({ error: 'Project not found' });
        }
        if (key.customer_status && !KEY_WRITABLE_STATUSES.has(key.customer_status)) {
          return res.status(403).json({ error: `Customer is ${key.customer_status} — writes are disabled` });
        }
        req.gatewayKey = key;
        req.project = { id: key.project_id, customer_id: null };
        if (!bodyProject) req.body = { ...(req.body ?? {}), project_id: key.project_id };
        await touchGatewayKey(key.id);
        return next();
      })
      .catch(next);
    return;
  }
  // Human path: full JWT auth, then the existing role gate — unchanged.
  // An already-authenticated request (req.auth set by an upstream
  // requireAuth mount) skips straight to the role gate.
  if (req.auth) {
    requireProjectRole(['owner', 'editor'], 'bodyProjectId')(req, res, next);
    return;
  }
  requireAuth(req, res, (err?: unknown) => {
    if (err) return next(err);
    requireProjectRole(['owner', 'editor'], 'bodyProjectId')(req, res, next);
  });
}

runtimeRouter.post('/invoke', invokeIpRateLimit, invokeAuth, invokeKeyRateLimit, invokeProjectRateLimit, validateBody(invokeSchema), asyncHandler(async (req, res) => {
  const { project_id, version, tool_name, args, prompt_ref, attribution } = req.body as {
    project_id: string; version: string; tool_name: string; args?: Record<string, unknown>; prompt_ref?: string;
    attribution?: { client?: string; trigger?: Trigger; session_id?: string; turn_id?: string; prompt?: string };
  };
  const result = await invoke({
    project_id, version, tool_name, args: args ?? {}, prompt_ref,
    client_ip: clientIpOf(req), rate_limit_checked: true,
    actor: req.gatewayKey ? gatewayActor(req.gatewayKey) : undefined,
    attribution: {
      channel: 'rest',
      client: attribution?.client ?? req.gatewayKey?.label ?? null,
      trigger: attribution?.trigger ?? (req.gatewayKey ? 'automated' : 'unknown'),
      trigger_source: attribution?.trigger ? 'declared' : 'inferred',
      session_id: attribution?.session_id ?? null,
      turn_id: attribution?.turn_id ?? null,
      prompt: attribution?.prompt ?? null,
    },
  });
  const status = result.ok ? 200 : result.error?.condition === 'RATE_LIMITED' ? 429 : 502;
  res.status(status).json(result);
}));

// GET /v1/projects/:id/telemetry — Operate screen data (the production
// architecture streams these through Kinesis → S3 → Athena).
// TE-02: `?days=` picks the lookback (default 14 days, as before). The window
// is clamped to the owning plan's retention server-side and the response's
// `retention.locked` tells the console to show the locked/upgrade state —
// an over-plan window is a 200, never an error.
runtimeRouter.get('/:id/telemetry', requireProjectRead(), asyncHandler(async (req, res) => {
  const pg = parsePagination(req.query as Record<string, any>);
  if (!pg.ok) return paginationError(res, pg.fields);
  let days = 14;
  const rawDays = (req.query as Record<string, any>).days;
  if (rawDays !== undefined && rawDays !== '') {
    const n = Number(rawDays);
    if (!Number.isFinite(n) || n <= 0) {
      return res.status(400).json({
        error: 'invalid_request', code: 'invalid_request',
        fields: { days: 'days must be a positive number' },
      });
    }
    days = n;
  }
  // Retention comes from the project's owning plan (packaging as data).
  // Legacy projects with no customer row resolve to null (no plan clamp;
  // the 12-month architecture cap still applies inside telemetrySummary).
  const planRows = await q(
    `SELECT p.telemetry_retention_days AS days
       FROM projects pr
       JOIN customers c ON c.id = pr.customer_id
       JOIN plans p ON p.id = c.plan_id
      WHERE pr.id = $1`,
    [req.params.id]);
  const retentionDays = planRows.length
    ? Number((planRows[0] as any).days)
    : null;
  res.json(await telemetrySummary(
    req.params.id, Math.round(days * 24), { limit: pg.limit, cursor: pg.cursor }, retentionDays,
  ));
}));
