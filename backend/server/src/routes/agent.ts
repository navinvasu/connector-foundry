// EV-08 agent tasks + the agent playground.
//
// Routes (mounted under /v1/projects):
//   GET    /:id/agent-tasks                      list (any member)
//   POST   /:id/agent-tasks                      owner-written task, approved (owner/editor)
//   POST   /:id/agent-tasks/generate             model-proposed tasks, status proposed (owner/editor)
//   PATCH  /:id/agent-tasks/:taskId              approve / reject / edit (owner/editor)
//   DELETE /:id/agent-tasks/:taskId              (owner/editor)
//   GET    /:id/eval/runs/:runId/agent-results   transcripts + scores of one run (any member)
//   POST   /:id/playground                       run one prompt against a release (owner/editor)
//
// Proposed tasks never run until a person approves them (propose → approve).

import { Router } from 'express';
import { z } from 'zod';
import { one, q, exec, J, jb, uid, audit } from '../db.js';
import { requireProjectRole, requireProjectRead } from '../auth.js';
import { validateBody } from '../validate.js';
import { asyncHandler, HttpError } from '../errors.js';
import { BudgetedLlm, requireLlm } from '../llm/index.js';
import { candidateToolset, releaseExecutor, releaseToolset } from '../agent/executors.js';
import { proposeTasks } from '../agent/tasks.js';
import { runAgent } from '../agent/runner.js';

export const agentRouter = Router();

const toolNames = z.array(z.string().trim().min(1).max(120)).max(30);

const taskCreateSchema = z.object({
  prompt: z.string({ error: 'prompt is required' }).trim().min(1, 'prompt is required').max(1000),
  expected_tools: toolNames.optional(),
  forbidden_tools: toolNames.optional(),
  answer_rubric: z.string().trim().max(1000).optional(),
});

const taskPatchSchema = taskCreateSchema.partial().extend({
  status: z.enum(['proposed', 'approved', 'rejected']).optional(),
});

const playgroundSchema = z.object({
  prompt: z.string({ error: 'prompt is required' }).trim().min(1, 'prompt is required').max(2000),
  version: z.string().trim().min(1).max(64).optional(),
});

function serialize(row: any) {
  return {
    ...row,
    expected_tools: J.parse(row.expected_tools, []),
    forbidden_tools: J.parse(row.forbidden_tools, []),
  };
}

agentRouter.get('/:id/agent-tasks', requireProjectRead(), asyncHandler(async (req, res) => {
  const rows = await q(
    `SELECT * FROM eval_agent_tasks WHERE project_id = $1 AND status <> 'rejected' ORDER BY created_at, id`,
    [req.params.id]);
  res.json({ tasks: rows.map(serialize) });
}));

agentRouter.post('/:id/agent-tasks', requireProjectRole(['owner', 'editor']), validateBody(taskCreateSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof taskCreateSchema>;
    const id = uid();
    await exec(
      `INSERT INTO eval_agent_tasks (id, project_id, prompt, expected_tools, forbidden_tools, answer_rubric, source, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'owner', 'approved')`,
      [id, req.params.id, body.prompt, jb(body.expected_tools ?? []), jb(body.forbidden_tools ?? []), body.answer_rubric ?? null]);
    await audit(req.params.id, 'agent_task.created', 'eval_agent_task', id, { source: 'owner' });
    res.status(201).json({ task: serialize(await one(`SELECT * FROM eval_agent_tasks WHERE id = $1`, [id])) });
  }));

agentRouter.post('/:id/agent-tasks/generate', requireProjectRole(['owner', 'editor']), asyncHandler(async (req, res) => {
  const llm = new BudgetedLlm(requireLlm());
  const toolset = await candidateToolset(req.params.id);
  if (toolset.tools.length === 0) {
    throw new HttpError(409, 'no_tools', 'Compile tools before generating agent tasks.');
  }
  const project = await one<any>(`SELECT name FROM projects WHERE id = $1`, [req.params.id]);
  const proposals = await proposeTasks(llm, String(project?.name ?? 'API'), toolset.tools);
  const ids: string[] = [];
  for (const p of proposals) {
    const id = uid();
    ids.push(id);
    await exec(
      `INSERT INTO eval_agent_tasks (id, project_id, prompt, expected_tools, forbidden_tools, answer_rubric, source, status, model)
       VALUES ($1, $2, $3, $4, $5, $6, 'llm', 'proposed', $7)`,
      [id, req.params.id, p.prompt, jb(p.expected_tools), jb(p.forbidden_tools), p.answer_rubric || null,
        `${llm.provider}/${llm.model}`]);
  }
  await audit(req.params.id, 'agent_task.generated', 'project', req.params.id,
    { count: ids.length, model: `${llm.provider}/${llm.model}`, tokens: llm.spent });
  const rows = ids.length
    ? await q(`SELECT * FROM eval_agent_tasks WHERE id = ANY($1) ORDER BY created_at, id`, [ids])
    : [];
  res.status(201).json({ tasks: rows.map(serialize), model: llm.model, tokens: llm.spent });
}));

agentRouter.patch('/:id/agent-tasks/:taskId', requireProjectRole(['owner', 'editor']), validateBody(taskPatchSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof taskPatchSchema>;
    const sets: string[] = [];
    const vals: unknown[] = [];
    const set = (col: string, v: unknown) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
    if (body.prompt !== undefined) set('prompt', body.prompt);
    if (body.expected_tools !== undefined) set('expected_tools', jb(body.expected_tools));
    if (body.forbidden_tools !== undefined) set('forbidden_tools', jb(body.forbidden_tools));
    if (body.answer_rubric !== undefined) set('answer_rubric', body.answer_rubric || null);
    if (body.status !== undefined) set('status', body.status);
    if (sets.length === 0) throw new HttpError(400, 'invalid_request', 'Nothing to update.');
    vals.push(req.params.taskId, req.params.id);
    const n = await exec(
      `UPDATE eval_agent_tasks SET ${sets.join(', ')}, updated_at = now()
        WHERE id = $${vals.length - 1} AND project_id = $${vals.length}`, vals);
    if (n === 0) throw new HttpError(404, 'task_not_found', 'Agent task not found');
    await audit(req.params.id, 'agent_task.updated', 'eval_agent_task', req.params.taskId, { status: body.status ?? null });
    res.json({ task: serialize(await one(`SELECT * FROM eval_agent_tasks WHERE id = $1`, [req.params.taskId])) });
  }));

agentRouter.delete('/:id/agent-tasks/:taskId', requireProjectRole(['owner', 'editor']), asyncHandler(async (req, res) => {
  const n = await exec(`DELETE FROM eval_agent_tasks WHERE id = $1 AND project_id = $2`, [req.params.taskId, req.params.id]);
  if (n === 0) throw new HttpError(404, 'task_not_found', 'Agent task not found');
  await audit(req.params.id, 'agent_task.deleted', 'eval_agent_task', req.params.taskId, {});
  res.status(204).end();
}));

agentRouter.get('/:id/eval/runs/:runId/agent-results', requireProjectRead(), asyncHandler(async (req, res) => {
  const run = await one<any>(`SELECT id FROM eval_runs WHERE id = $1 AND project_id = $2`, [req.params.runId, req.params.id]);
  if (!run) throw new HttpError(404, 'eval_run_not_found', 'Eval run not found');
  const rows = await q(
    `SELECT * FROM eval_agent_results WHERE eval_run_id = $1 ORDER BY created_at, id`, [req.params.runId]);
  res.json({
    results: rows.map((r: any) => ({ ...r, checks: J.parse(r.checks, []), transcript: J.parse(r.transcript, null) })),
  });
}));

agentRouter.post('/:id/playground', requireProjectRole(['owner', 'editor']), validateBody(playgroundSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof playgroundSchema>;
    const llm = new BudgetedLlm(requireLlm());
    let toolset;
    try {
      toolset = await releaseToolset(req.params.id, body.version ?? 'prod');
    } catch (e) {
      throw new HttpError(409, 'no_release', e instanceof Error ? e.message : 'No release to run against.');
    }
    const transcript = await runAgent({
      llm, prompt: body.prompt, tools: toolset.tools, execute: releaseExecutor(req.params.id, toolset.version),
    });
    res.json({ release_version: toolset.version, transcript });
  }));
