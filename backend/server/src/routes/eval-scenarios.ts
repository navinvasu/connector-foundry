// EV-04: custom eval scenario CRUD — per-tool, project-scoped.
//
// Routes (mounted under /v1/projects):
//   GET    /:id/tools/:toolId/eval-scenarios            list (any member)
//   POST   /:id/tools/:toolId/eval-scenarios            create (owner/editor)
//   PATCH  /:id/tools/:toolId/eval-scenarios/:scenarioId update (owner/editor)
//   DELETE /:id/tools/:toolId/eval-scenarios/:scenarioId delete (owner/editor)
//
// Tenancy follows the house rules: reads use requireProjectRead (any
// role, outsiders 404); mutations use requireProjectRole (owner/editor,
// non-writable workspace 403). The tool must belong to the project in
// the URL — a cross-project tool id answers the same 404 as an unknown
// tool, so scenario existence never leaks across projects.

import { Router } from 'express';
import { one, q, exec, J, jb, uid, audit } from '../db.js';
import { requireProjectRole, requireProjectRead } from '../auth.js';
import { validateBody, evalScenarioCreateSchema, evalScenarioPatchSchema } from '../validate.js';
import { asyncHandler, HttpError } from '../errors.js';
import { parseCustomScenarioRow } from '../custom-scenarios.js';

export const evalScenariosRouter = Router();

interface ToolAnchor { id: string; project_id: string }

async function anchorTool(projectId: string, toolId: string): Promise<ToolAnchor> {
  const row = await one<ToolAnchor>(
    `SELECT id, project_id FROM canonical_tools WHERE id = $1 AND project_id = $2`, [toolId, projectId]);
  if (!row) throw new HttpError(404, 'tool_not_found', 'Tool not found');
  return row;
}

function serialize(row: unknown) {
  const scenario = parseCustomScenarioRow(row);
  if (!scenario) throw new HttpError(500, 'internal_error', 'Stored scenario could not be read');
  return {
    id: scenario.id, project_id: scenario.project_id, tool_id: scenario.tool_id,
    name: scenario.name, given_args: scenario.given_args,
    expect_status: scenario.expect_status, expect_body_keys: scenario.expect_body_keys,
    enabled: scenario.enabled,
    created_by: scenario.created_by ?? null,
    created_at: scenario.created_at, updated_at: scenario.updated_at,
  };
}

/** Trim + dedupe expected keys, preserving author order. */
function normalizeKeys(keys: string[] | undefined): string[] {
  const out: string[] = [];
  for (const k of keys ?? []) {
    const t = k.trim();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

evalScenariosRouter.get('/:id/tools/:toolId/eval-scenarios', requireProjectRead(), asyncHandler(async (req, res) => {
  await anchorTool(req.params.id, req.params.toolId);
  const rows = await q(
    `SELECT * FROM eval_custom_scenarios WHERE project_id = $1 AND tool_id = $2
      ORDER BY created_at ASC, name ASC`,
    [req.params.id, req.params.toolId]);
  res.json({ scenarios: rows.map(serialize) });
}));

evalScenariosRouter.post(
  '/:id/tools/:toolId/eval-scenarios',
  requireProjectRole(['owner', 'editor']),
  validateBody(evalScenarioCreateSchema),
  asyncHandler(async (req, res) => {
    const projectId = req.params.id;
    const tool = await anchorTool(projectId, req.params.toolId);
    const body = req.body as {
      name: string; given_args?: Record<string, unknown>;
      expect_status?: number | null; expect_body_keys?: string[]; enabled?: boolean;
    };
    const name = String(body.name).trim();
    const clash = await one(
      `SELECT id FROM eval_custom_scenarios WHERE tool_id = $1 AND name = $2`, [tool.id, name]);
    if (clash) {
      throw new HttpError(409, 'scenario_name_conflict',
        `A custom scenario named "${name}" already exists for this tool — scenario names are unique per tool.`);
    }
    const id = uid();
    const row = await one(
      `INSERT INTO eval_custom_scenarios
         (id, project_id, tool_id, name, given_args, expect_status, expect_body_keys, enabled, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [id, projectId, tool.id, name,
       jb(body.given_args ?? {}),
       body.expect_status ?? null,
       jb(normalizeKeys(body.expect_body_keys)),
       body.enabled ?? true,
       req.auth?.userId ?? null]);
    await audit(projectId, 'eval_scenario.created', 'eval_custom_scenario', id,
      { tool_id: tool.id, name });
    res.status(201).json({ scenario: serialize(row) });
  }),
);

evalScenariosRouter.patch(
  '/:id/tools/:toolId/eval-scenarios/:scenarioId',
  requireProjectRole(['owner', 'editor']),
  validateBody(evalScenarioPatchSchema),
  asyncHandler(async (req, res) => {
    const projectId = req.params.id;
    const tool = await anchorTool(projectId, req.params.toolId);
    const existing = await one<any>(
      `SELECT * FROM eval_custom_scenarios WHERE id = $1 AND tool_id = $2 AND project_id = $3`,
      [req.params.scenarioId, tool.id, projectId]);
    if (!existing) throw new HttpError(404, 'scenario_not_found', 'Custom scenario not found');
    const body = req.body as {
      name?: string; given_args?: Record<string, unknown>;
      expect_status?: number | null; expect_body_keys?: string[]; enabled?: boolean;
    };
    if (body.name !== undefined && body.name.trim() !== existing.name) {
      const clash = await one(
        `SELECT id FROM eval_custom_scenarios WHERE tool_id = $1 AND name = $2`,
        [tool.id, body.name.trim()]);
      if (clash) {
        throw new HttpError(409, 'scenario_name_conflict',
          `A custom scenario named "${body.name.trim()}" already exists for this tool — scenario names are unique per tool.`);
      }
    }
    const sets: string[] = [];
    const vals: unknown[] = [];
    const push = (col: string, value: unknown) => { sets.push(`${col} = $${sets.length + 1}`); vals.push(value); };
    if (body.name !== undefined) push('name', body.name.trim());
    if (body.given_args !== undefined) push('given_args', jb(body.given_args));
    if (body.expect_status !== undefined) push('expect_status', body.expect_status ?? null);
    if (body.expect_body_keys !== undefined) push('expect_body_keys', jb(normalizeKeys(body.expect_body_keys)));
    if (body.enabled !== undefined) push('enabled', body.enabled);
    if (sets.length === 0) {
      throw new HttpError(400, 'invalid_request', 'Nothing to update. Allowed: name, given_args, expect_status, expect_body_keys, enabled');
    }
    vals.push(req.params.scenarioId);
    const row = await one(
      `UPDATE eval_custom_scenarios SET ${sets.join(', ')}, updated_at = now()
        WHERE id = $${vals.length} RETURNING *`, vals);
    await audit(projectId, 'eval_scenario.updated', 'eval_custom_scenario', req.params.scenarioId,
      { tool_id: tool.id, fields: sets.map((s) => s.split(' ')[0]) });
    res.json({ scenario: serialize(row) });
  }),
);

evalScenariosRouter.delete(
  '/:id/tools/:toolId/eval-scenarios/:scenarioId',
  requireProjectRole(['owner', 'editor']),
  asyncHandler(async (req, res) => {
    const projectId = req.params.id;
    const tool = await anchorTool(projectId, req.params.toolId);
    const n = await exec(
      `DELETE FROM eval_custom_scenarios WHERE id = $1 AND tool_id = $2 AND project_id = $3`,
      [req.params.scenarioId, tool.id, projectId]);
    if (n === 0) throw new HttpError(404, 'scenario_not_found', 'Custom scenario not found');
    await audit(projectId, 'eval_scenario.deleted', 'eval_custom_scenario', req.params.scenarioId,
      { tool_id: tool.id });
    res.json({ ok: true, scenario_id: req.params.scenarioId });
  }),
);
