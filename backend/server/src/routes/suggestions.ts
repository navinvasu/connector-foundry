// HK-09 fix suggestions. Routes (mounted under /v1/projects):
//   GET  /:id/suggestions                      open + decided suggestions (any member)
//   POST /:id/suggestions/generate             propose from current evidence (owner/editor)
//   POST /:id/suggestions/:suggestionId/accept apply to the tool (owner/editor; optional edited `after`)
//   POST /:id/suggestions/:suggestionId/reject (owner/editor)

import { Router } from 'express';
import { z } from 'zod';
import { q, exec, J, audit } from '../db.js';
import { requireProjectRole, requireProjectRead } from '../auth.js';
import { validateBody } from '../validate.js';
import { asyncHandler, HttpError } from '../errors.js';
import { BudgetedLlm, requireLlm } from '../llm/index.js';
import {
  acceptSuggestion, gatherEvidence, proposeSuggestions, storeSuggestions, type ToolForSuggestions,
} from '../suggestions.js';

export const suggestionsRouter = Router();

const acceptSchema = z.object({ after: z.string().trim().min(1).max(4000).optional() });

function serialize(row: any) {
  return { ...row, evidence: J.parse(row.evidence, []) };
}

suggestionsRouter.get('/:id/suggestions', requireProjectRead(), asyncHandler(async (req, res) => {
  const rows = await q(
    `SELECT s.*, t.name AS tool_name FROM fix_suggestions s
       LEFT JOIN canonical_tools t ON t.id = s.tool_id
      WHERE s.project_id = $1 AND s.status <> 'superseded'
      ORDER BY (s.status = 'proposed') DESC, s.created_at DESC LIMIT 100`, [req.params.id]);
  res.json({ suggestions: rows.map(serialize) });
}));

suggestionsRouter.post('/:id/suggestions/generate', requireProjectRole(['owner', 'editor']), asyncHandler(async (req, res) => {
  const llm = new BudgetedLlm(requireLlm());
  const tools = await q<ToolForSuggestions>(
    `SELECT id, name, description, eligible_use, ineligible_use, input_schema FROM canonical_tools
      WHERE project_id = $1 AND status IN ('candidate','approved','tested','released') ORDER BY name`, [req.params.id]);
  if (tools.length === 0) throw new HttpError(409, 'no_tools', 'Compile tools before asking for suggestions.');
  const evidence = await gatherEvidence(req.params.id);
  if (evidence.length === 0) {
    return res.status(200).json({ suggestions: [], evidence: 0, message: 'No open findings or failures to fix. Run an evaluation first.' });
  }
  const proposals = await proposeSuggestions(llm, tools, evidence);
  const model = `${llm.provider}/${llm.model}`;
  const ids = await storeSuggestions(req.params.id, proposals, model);
  await audit(req.params.id, 'suggestions.generated', 'project', req.params.id,
    { count: ids.length, evidence: evidence.length, model, tokens: llm.spent });
  const rows = ids.length
    ? await q(`SELECT s.*, t.name AS tool_name FROM fix_suggestions s LEFT JOIN canonical_tools t ON t.id = s.tool_id
                WHERE s.id = ANY($1) ORDER BY s.created_at, s.id`, [ids])
    : [];
  res.status(201).json({ suggestions: rows.map(serialize), evidence: evidence.length, model, tokens: llm.spent });
}));

suggestionsRouter.post('/:id/suggestions/:suggestionId/accept', requireProjectRole(['owner', 'editor']), validateBody(acceptSchema),
  asyncHandler(async (req, res) => {
    const out = await acceptSuggestion(req.params.id, req.params.suggestionId, req.auth?.userId ?? null, req.body?.after);
    if (out.status === 404) throw new HttpError(404, 'suggestion_not_found', 'Suggestion not found');
    if (out.status === 409) throw new HttpError(409, 'suggestion_decided', `Suggestion is already ${out.current}`);
    await audit(req.params.id, 'suggestion.accepted', 'fix_suggestion', req.params.suggestionId, {});
    res.json({ ok: true });
  }));

suggestionsRouter.post('/:id/suggestions/:suggestionId/reject', requireProjectRole(['owner', 'editor']), asyncHandler(async (req, res) => {
  const n = await exec(
    `UPDATE fix_suggestions SET status = 'rejected', decided_by = $1, decided_at = now()
      WHERE id = $2 AND project_id = $3 AND status = 'proposed'`,
    [req.auth?.userId ?? null, req.params.suggestionId, req.params.id]);
  if (n === 0) throw new HttpError(404, 'suggestion_not_found', 'No open suggestion with that id');
  await audit(req.params.id, 'suggestion.rejected', 'fix_suggestion', req.params.suggestionId, {});
  res.json({ ok: true });
}));
