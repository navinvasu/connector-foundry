import { Router } from 'express';
import { one, q, exec, withTx, J, jb, uid, audit } from '../db.js';
import { CONNECTOR_TARGETS, defaultTargets, normalizeTargets } from '../release.js';
import { membershipIn, customerWritable, requireProjectRole, requireProjectRead } from '../auth.js';
import { validateBody, projectCreateSchema, projectPatchSchema, toolPatchSchema } from '../validate.js';
import { asyncHandler, HttpError } from '../errors.js';
import {
  parsePagination, paginationError, keysetClause, buildPage,
} from '../paginate.js';
import { withParamDescription } from '../suggestions.js';

export const projectsRouter = Router();

// Project rows with registry-summary counts, so the console's project list
// can render tools/eval/blocker stats without N+1 queries.
const PROJECT_SUMMARY_SELECT = `
  p.*,
  c.name AS customer_name,
  (SELECT COUNT(*)::int FROM operations o WHERE o.project_id = p.id) AS operations_count,
  (SELECT COUNT(*)::int FROM canonical_tools t WHERE t.project_id = p.id) AS tools_total,
  (SELECT COUNT(*)::int FROM canonical_tools t WHERE t.project_id = p.id AND t.status IN ('approved', 'tested', 'released')) AS tools_approved,
  (SELECT COUNT(*)::int FROM review_items r WHERE r.project_id = p.id AND r.status = 'open') AS open_review_items,
  (SELECT s.source_type FROM api_sources s WHERE s.project_id = p.id ORDER BY s.created_at DESC LIMIT 1) AS latest_source_type,
  (SELECT s.location FROM api_sources s WHERE s.project_id = p.id ORDER BY s.created_at DESC LIMIT 1) AS latest_source_location
`;
const PROJECT_SUMMARY_FROM = `FROM projects p LEFT JOIN customers c ON c.id = p.customer_id`;
// Projects are scoped to the caller's customers (platform admins read any
// single project, like requireProjectRead).
// BE-08: keyset pagination (?limit= defaults 50, max 100; ?cursor= from the
// previous page's pagination.next_cursor). Newest first, (created_at, id)
// ordering so pages stay stable as projects are created.
projectsRouter.get('/', asyncHandler(async (req, res) => {
  const pg = parsePagination(req.query as Record<string, any>);
  if (!pg.ok) return paginationError(res, pg.fields);
  const ids = (req.auth?.memberships ?? []).map((m) => m.customerId);
  const { clause, params } = keysetClause({
    cursor: pg.cursor, direction: 'DESC', keyCol: 'p.created_at', idCol: 'p.id', paramStart: 2,
  });
  const rows = await q(
    `SELECT ${PROJECT_SUMMARY_SELECT} ${PROJECT_SUMMARY_FROM}
      WHERE p.customer_id = ANY($1)${clause}
      ORDER BY p.created_at DESC, p.id DESC LIMIT $${params.length + 2}`,
    [ids, ...params, pg.limit + 1],
  );
  const page = buildPage(rows as Record<string, any>[], pg.limit, 'created_at', 'id');
  res.json({ projects: page.items, pagination: page.meta });
}));

// GET /v1/projects/:id — single project with the same summary. Scoped like
// the list: a project outside the caller's customers reads as 404.
projectsRouter.get('/:id', asyncHandler(async (req, res) => {
  const ids = (req.auth?.memberships ?? []).map((m) => m.customerId);
  const row = await one(
    `SELECT ${PROJECT_SUMMARY_SELECT} ${PROJECT_SUMMARY_FROM}
      WHERE p.id = $1 AND (p.customer_id = ANY($2) OR $3)`,
    [req.params.id, ids, Boolean(req.auth?.isPlatformAdmin)],
  );
  if (!row) return res.status(404).json({ error: 'Project not found' });
  res.json({ project: row });
}));

// SE-04: parse the JSONB columns of an exported row (pg returns objects for
// JSONB; TEXT-era rows come back as strings — J.parse accepts both).
function parseFields<T extends Record<string, any>>(row: T, fields: string[]): T {
  const out: Record<string, any> = { ...row };
  for (const f of fields) out[f] = J.parse(row[f], null);
  return out as T;
}

// GET /v1/projects/:id/export — SE-04: download everything we hold for a
// project as one JSON document (spec snapshots, tools + recovery rules,
// review items, eval history, release manifests, jobs, telemetry). Read
// access follows the project visibility rule (member of the owning
// customer, or a platform admin); Content-Disposition makes
// browsers save the response as a file.
projectsRouter.get('/:id/export', asyncHandler(async (req, res) => {
  const ids = (req.auth?.memberships ?? []).map((m) => m.customerId);
  const project = await one(
    `SELECT * FROM projects WHERE id = $1 AND (customer_id = ANY($2) OR $3)`,
    [req.params.id, ids, Boolean(req.auth?.isPlatformAdmin)],
  );
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const id = req.params.id;
  const byCreated = 'ORDER BY created_at ASC, id ASC';

  const sources = (await q(`SELECT * FROM api_sources WHERE project_id = $1 ${byCreated}`, [id]))
    .map((s: any) => parseFields(s, ['spec_body']));
  const operations = await q(`SELECT * FROM operations WHERE project_id = $1 ${byCreated}`, [id]);

  const toolRows = await q(
    `SELECT * FROM canonical_tools WHERE project_id = $1 ORDER BY name ASC, id ASC`, [id]);
  const tools = [];
  for (const t of toolRows as any[]) {
    const rules = await q(
      `SELECT * FROM tool_recovery_rules WHERE tool_id = $1 ORDER BY tool_version ASC, condition ASC`, [t.id]);
    tools.push({
      ...parseFields(t, ['input_schema', 'output_schema', 'pagination', 'upstream',
        'effect_classes', 'required_scopes', 'token_lifecycle', 'provenance']),
      recovery_rules: rules,
    });
  }

  const reviewItems = (await q(`SELECT * FROM review_items WHERE project_id = $1 ${byCreated}`, [id]))
    .map((r: any) => parseFields(r, ['evidence']));

  // 🐞 BE-02: eval_runs has no created_at column (it uses started_at) —
  // the shared byCreated ordering 500'd every export. Order by started_at.
  const runRows = await q(`SELECT * FROM eval_runs WHERE project_id = $1 ORDER BY started_at ASC, id ASC`, [id]);
  const evalRuns = [];
  for (const r of runRows as any[]) {
    const results = await q(`SELECT * FROM eval_results WHERE eval_run_id = $1 ${byCreated}`, [r.id]);
    evalRuns.push({
      ...parseFields(r, ['summary']),
      results: results.map((x: any) => ({ ...parseFields(x, ['detail']), passed: Boolean(x.passed) })),
    });
  }

  const releaseRows = await q(`SELECT * FROM releases WHERE project_id = $1 ${byCreated}`, [id]);
  const releases = [];
  for (const r of releaseRows as any[]) {
    const releaseTools = await q(
      `SELECT * FROM release_tools WHERE release_id = $1 ORDER BY tool_id ASC`, [r.id]);
    releases.push({
      ...parseFields(r, ['manifest']),
      tools: releaseTools.map((x: any) => parseFields(x, ['tool_snapshot'])),
    });
  }

  const jobs = (await q(`SELECT * FROM jobs WHERE project_id = $1 ${byCreated}`, [id]))
    .map((j: any) => parseFields(j, ['payload', 'progress', 'result']));
  const telemetry = await q(`SELECT * FROM telemetry_events WHERE project_id = $1 ${byCreated}`, [id]);

  // EV-04: the owner's custom scenario definitions ride along — they are
  // part of what the project holds, and an export without them would
  // silently drop the edge cases gating release.
  const evalCustomScenarios = (await q(
    `SELECT * FROM eval_custom_scenarios WHERE project_id = $1 ${byCreated}`, [id]))
    .map((s: any) => parseFields(s, ['given_args', 'expect_body_keys']));

  // AB-02: credential metadata only — the vault envelope (vault_handle)
  // and the material are never exported. The allowlist is structural (not
  // just the SELECT list) so the response shape can't drift with the query.
  const credentialRows = await q(
    `SELECT id, project_id, label, kind, key_fingerprint, status, created_by,
            created_at, rotated_at, revoked_at
       FROM project_credentials WHERE project_id = $1 ${byCreated}`, [id]);
  const credentials = (credentialRows as any[]).map((c) => ({
    id: c.id, project_id: c.project_id, label: c.label, kind: c.kind,
    fingerprint: c.key_fingerprint, status: c.status, created_by: c.created_by ?? null,
    created_at: c.created_at, rotated_at: c.rotated_at ?? null, revoked_at: c.revoked_at ?? null,
  }));

  // TE-03: drift history rides along — checks and alerts are part of what
  // the project holds, and an export without them would silently drop the
  // "did my API break" record.
  const driftChecks = (await q(
    `SELECT * FROM drift_checks WHERE project_id = $1 ORDER BY started_at ASC, id ASC`, [id]))
    .map((c: any) => parseFields(c, ['summary']));
  const driftAlerts = (await q(
    `SELECT * FROM drift_alerts WHERE project_id = $1 ORDER BY first_seen_at ASC, id ASC`, [id]))
    .map((a: any) => parseFields(a, ['evidence']));

  res.setHeader('Content-Disposition', `attachment; filename="connector-foundry-project-${id}-export.json"`);
  res.json({
    export_version: 1,
    exported_at: new Date().toISOString(),
    project: parseFields(project as any, ['targets']),
    counts: {
      sources: sources.length, operations: operations.length, tools: tools.length,
      review_items: reviewItems.length, eval_runs: evalRuns.length,
      releases: releases.length, jobs: jobs.length, telemetry_events: telemetry.length,
      credentials: credentials.length, eval_custom_scenarios: evalCustomScenarios.length,
      drift_checks: driftChecks.length, drift_alerts: driftAlerts.length,
    },
    sources, operations, tools, review_items: reviewItems,
    eval_runs: evalRuns, releases, jobs, telemetry_events: telemetry,
    credentials, eval_custom_scenarios: evalCustomScenarios,
    drift_checks: driftChecks, drift_alerts: driftAlerts,
  });
}));

// DELETE /v1/projects/:id — SE-04: permanently delete a project and every
// row it owns. Owner-only (requireProjectRole also 404s outsiders, so
// existence never leaks). Most child tables cascade from projects
// (schema.sql) — including project_credentials (AB-02): the cascade fires
// on the DELETE FROM projects below, after the
// explicit FK-less deletes, so no separate credentials delete is needed.
// telemetry_events and audit_events carry a plain project_id with no FK,
// so they are deleted explicitly in the same transaction. The deletion
// itself is audit-logged as a tombstone row with project_id NULL — a
// project-scoped row would be deleted with everything else; the tombstone
// keeps the fact of deletion, never the content.
projectsRouter.delete('/:id', requireProjectRole(['owner']), asyncHandler(async (req, res) => {
  const id = req.params.id;
  const deleted = await withTx(async (t) => {
    const countsRow = (await t.query(
      `SELECT (SELECT name FROM projects WHERE id = $1) AS project_name,
        (SELECT COUNT(*)::int FROM api_sources WHERE project_id = $1) AS sources,
        (SELECT COUNT(*)::int FROM operations WHERE project_id = $1) AS operations,
        (SELECT COUNT(*)::int FROM canonical_tools WHERE project_id = $1) AS tools,
        (SELECT COUNT(*)::int FROM tool_recovery_rules r JOIN canonical_tools ct ON ct.id = r.tool_id WHERE ct.project_id = $1) AS recovery_rules,
        (SELECT COUNT(*)::int FROM review_items WHERE project_id = $1) AS review_items,
        (SELECT COUNT(*)::int FROM eval_runs WHERE project_id = $1) AS eval_runs,
        (SELECT COUNT(*)::int FROM eval_results er JOIN eval_runs r ON r.id = er.eval_run_id WHERE r.project_id = $1) AS eval_results,
        (SELECT COUNT(*)::int FROM releases WHERE project_id = $1) AS releases,
        (SELECT COUNT(*)::int FROM release_tools rt JOIN releases r ON r.id = rt.release_id WHERE r.project_id = $1) AS release_tools,
        (SELECT COUNT(*)::int FROM jobs WHERE project_id = $1) AS jobs,
        (SELECT COUNT(*)::int FROM telemetry_events WHERE project_id = $1) AS telemetry_events,
        (SELECT COUNT(*)::int FROM audit_events WHERE project_id = $1) AS audit_events,
        (SELECT COUNT(*)::int FROM project_credentials WHERE project_id = $1) AS credentials,
        (SELECT COUNT(*)::int FROM eval_custom_scenarios WHERE project_id = $1) AS eval_custom_scenarios,
        (SELECT COUNT(*)::int FROM drift_checks WHERE project_id = $1) AS drift_checks,
        (SELECT COUNT(*)::int FROM drift_alerts WHERE project_id = $1) AS drift_alerts`,
      [id])).rows[0];
    const { project_name: projectName, ...counts } = countsRow;
    await t.query(`DELETE FROM telemetry_events WHERE project_id = $1`, [id]);
    await t.query(`DELETE FROM audit_events WHERE project_id = $1`, [id]);
    const del = await t.query(`DELETE FROM projects WHERE id = $1`, [id]);
    if (!del.rowCount) throw new HttpError(404, 'project_not_found', 'Project not found');
    await t.query(
      `INSERT INTO audit_events (id, project_id, actor_user_id, action, entity_type, entity_id, metadata)
       VALUES ($1, NULL, $2, 'project.deleted', 'project', $3, $4)`,
      [uid(), req.auth?.userId ?? null, id,
       jb({ project_name: projectName, customer_id: req.project?.customer_id ?? null, deleted_counts: counts })]);
    return counts;
  });
  res.json({ ok: true, project_id: id, deleted });
}));

projectsRouter.post('/', validateBody(projectCreateSchema), asyncHandler(async (req, res) => {
  const { name, description } = req.body as { name: string; description?: string };
  // Customer-selected connector targets; default is the v1 set.
  const targets = req.body?.targets === undefined ? defaultTargets() : normalizeTargets(req.body.targets);
  if (targets.length === 0) {
    return res.status(400).json({ error: `Select at least one target. Known targets: ${CONNECTOR_TARGETS.join(', ')}` });
  }

  // Resolve the owning customer: explicit customer_id wins, else the
  // caller's first writable membership. Enforce the plan's project cap.
  let customerId: string | null = null;
  if (req.body?.customer_id) {
    const m = membershipIn(req, String(req.body.customer_id));
    if (!m || (m.role !== 'owner' && m.role !== 'editor')) {
      return res.status(403).json({ error: 'Not an owner or editor of that customer' });
    }
    if (!customerWritable(m)) {
      return res.status(403).json({ error: `Customer is ${m.customerStatus} — new projects are disabled` });
    }
    customerId = m.customerId;
  } else {
    const m = (req.auth?.memberships ?? [])
      .filter((x) => (x.role === 'owner' || x.role === 'editor') && customerWritable(x))[0];
    customerId = m?.customerId ?? null;
  }
  // Every project belongs to an organization: a signed-in user without one
  // creates it first (POST /v1/me/organization), so no project is ever
  // visible outside its customer.
  if (!customerId) {
    return res.status(409).json({
      error: 'Create an organization before adding a project.',
      code: 'organization_required',
    });
  }
  const m = membershipIn(req, customerId) ?? req.customer;
  const used = await one<any>(
    `SELECT COUNT(*)::int AS n FROM projects WHERE customer_id = $1 AND status = 'active'`, [customerId]);
  const cap = req.auth?.isPlatformAdmin ? -1 : Number(m?.projectCap ?? -1);
  if (cap !== -1 && used.n >= cap) {
    return res.status(409).json({
      error: `Project limit reached (${used.n}/${cap}). Upgrade the plan to add more projects.`,
      code: 'project_limit_reached',
      plan_name: m?.planName ?? undefined,
      projects_used: used.n,
      project_cap: cap,
    });
  }

  const id = uid();
  await exec(
    `INSERT INTO projects (id, name, description, targets, customer_id, owner_user_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, String(name), description ? String(description) : null, jb(targets), customerId, req.auth?.userId ?? null]);
  await audit(id, 'project.created', 'project', id, { name, targets, customer_id: customerId });
  res.status(201).json({ project: await one(`SELECT * FROM projects WHERE id = $1`, [id]) });
}));

// PATCH /v1/projects/:id — rename / re-describe / change connector targets.
// Customers can add targets over time (e.g. start with MCP, add OpenAI and Muse later).
projectsRouter.patch('/:id', requireProjectRole(['owner', 'editor']), validateBody(projectPatchSchema), asyncHandler(async (req, res) => {
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (req.body?.name !== undefined) {
    sets.push(`name = $${sets.length + 1}`); vals.push(String(req.body.name));
  }
  if (req.body?.description !== undefined) {
    sets.push(`description = $${sets.length + 1}`); vals.push(req.body.description ? String(req.body.description) : null);
  }
  if (req.body?.targets !== undefined) {
    const targets = normalizeTargets(req.body.targets);
    if (targets.length === 0) {
      return res.status(400).json({ error: `Select at least one target. Known targets: ${CONNECTOR_TARGETS.join(', ')}` });
    }
    sets.push(`targets = $${sets.length + 1}`); vals.push(jb(targets));
  }
  if (req.body?.capture_prompts !== undefined) {
    sets.push(`capture_prompts = $${sets.length + 1}`); vals.push(Boolean(req.body.capture_prompts));
  }
  if (sets.length === 0) return res.status(400).json({ error: 'Nothing to update. Allowed: name, description, targets, capture_prompts' });
  vals.push(req.params.id);
  const n = await exec(
    `UPDATE projects SET ${sets.join(', ')}, updated_at = now() WHERE id = $${vals.length}`, vals);
  if (n === 0) return res.status(404).json({ error: 'Project not found' });
  const project = await one(`SELECT * FROM projects WHERE id = $1`, [req.params.id]);
  await audit(req.params.id, 'project.updated', 'project', req.params.id, { fields: sets.map((s) => s.split(' ')[0]) });
  res.json({ project });
}));

export const toolsRouter = Router();

// NOTE: POST /v1/projects/:id/compile now enqueues a background job —
// see routes/jobs.ts. Conversion runs on the queue, not the request thread.

// BE-09: tenant-scoped read (requireProjectRead) like every project GET.
toolsRouter.get('/:id/tools', requireProjectRead(), asyncHandler(async (req, res) => {
  const pg = parsePagination(req.query as Record<string, any>);
  if (!pg.ok) return paginationError(res, pg.fields);
  // Name-ordered (existing console behavior); keyset on (name, id).
  const { clause, params } = keysetClause({
    cursor: pg.cursor, direction: 'ASC', keyCol: 'name', idCol: 'id', paramStart: 2,
  });
  const rows = await q(
    `SELECT * FROM canonical_tools WHERE project_id = $1${clause}
     ORDER BY name ASC, id ASC LIMIT $${params.length + 2}`,
    [req.params.id, ...params, pg.limit + 1],
  ) as any[];
  const page = buildPage(rows, pg.limit, 'name', 'id');
  const tools = [];
  for (const t of page.items) {
    const rules = await q(`SELECT * FROM tool_recovery_rules WHERE tool_id = $1 AND tool_version = $2`, [t.id, t.version]);
    tools.push({
      ...t,
      input_schema: J.parse(t.input_schema, {}),
      output_schema: J.parse(t.output_schema, {}),
      upstream: J.parse(t.upstream, {}),
      effect_classes: J.parse(t.effect_classes, []),
      required_scopes: J.parse(t.required_scopes, []),
      provenance: J.parse(t.provenance, []),
      recovery_rules: rules,
    });
  }
  res.json({ tools, pagination: page.meta });
}));

// PATCH /v1/projects/tools/:toolId — edit fields / approve (status: candidate→approved)
toolsRouter.patch('/tools/:toolId', requireProjectRole(['owner', 'editor'], 'toolParam'), validateBody(toolPatchSchema), asyncHandler(async (req, res) => {
  const allowed = ['name', 'description', 'purpose', 'eligible_use', 'ineligible_use', 'status', 'confirmation_required'];
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const k of allowed) {
    if (req.body?.[k] !== undefined) { sets.push(`${k} = $${sets.length + 1}`); vals.push(req.body[k]); }
  }
  if (req.body?.effect_classes !== undefined) {
    sets.push(`effect_classes = $${sets.length + 1}`);
    vals.push(jb(req.body.effect_classes));
  }
  const paramEdits = req.body?.param_descriptions as Record<string, string> | undefined;
  if (sets.length === 0 && !paramEdits) {
    return res.status(400).json({ error: `Nothing to update. Allowed: ${[...allowed, 'effect_classes', 'param_descriptions'].join(', ')}` });
  }
  const approving = req.body?.status === 'approved';
  const existing = await one(`SELECT * FROM canonical_tools WHERE id = $1`, [req.params.toolId]) as any;
  if (!existing) return res.status(404).json({ error: 'Tool not found' });
  // Effect/confirmation edits change release semantics, so they bump the
  // draft version (with recovery-rule carry-forward) exactly like approving —
  // never a silent change to a released tool.
  const effectChanged = (() => {
    try {
      const before = J.parse(existing.effect_classes, []);
      const after = req.body?.effect_classes;
      return after !== undefined && JSON.stringify([...after].sort()) !== JSON.stringify([...before].sort());
    } catch { return req.body?.effect_classes !== undefined; }
  })();
  const confirmationChanged = req.body?.confirmation_required !== undefined
    && Boolean(req.body.confirmation_required) !== Boolean(existing.confirmation_required);
  const versioned = approving || effectChanged || confirmationChanged;
  if (paramEdits && Object.keys(paramEdits).length > 0) {
    let schema: unknown = existing.input_schema;
    try {
      for (const [param, text] of Object.entries(paramEdits)) schema = withParamDescription(schema, param, text);
    } catch (e) {
      return res.status(400).json({ error: e instanceof Error ? e.message : 'Invalid param_descriptions' });
    }
    sets.push(`input_schema = $${sets.length + 1}`);
    vals.push(jb(schema));
  }
  vals.push(req.params.toolId);
  // Approving bumps the draft version (edits never silently change a released tool).
  // BE-00: the version bump and the recovery-rule carry-forward happen in one
  // transaction — release freeze filters rules by the tool's current version, so
  // without the copy approved tools would freeze with zero recovery rules.
  // RETURNING pins the versions actually written, so concurrent approvals
  // can't copy rules to a stale version.
  await withTx(async (t) => {
    const bump = versioned ? ', version = version + 1' : '';
    const upd = await t.query(
      `UPDATE canonical_tools SET ${sets.join(', ')}${bump}, updated_at = now()
       WHERE id = $${vals.length} RETURNING version`, vals);
    if (versioned) {
      const newVersion = upd.rows[0].version as number;
      const rules = await t.query(
        `SELECT condition, detection_rule, behavior, recovery_action, max_attempts, backoff_ms, user_message
         FROM tool_recovery_rules WHERE tool_id = $1 AND tool_version = $2`,
        [req.params.toolId, newVersion - 1]);
      for (const r of rules.rows) {
        await t.query(
          `INSERT INTO tool_recovery_rules
           (id, tool_id, tool_version, condition, detection_rule, behavior, recovery_action,
            max_attempts, backoff_ms, user_message)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [uid(), req.params.toolId, newVersion, r.condition, r.detection_rule,
           r.behavior, r.recovery_action, r.max_attempts, r.backoff_ms, r.user_message]);
      }
    }
  });
  const tool = await one(`SELECT * FROM canonical_tools WHERE id = $1`, [req.params.toolId]) as any;
  await audit(tool.project_id, `tool.${approving ? 'approved' : 'edited'}`, 'canonical_tool', tool.id, { name: tool.name });
  res.json({ tool });
}));
