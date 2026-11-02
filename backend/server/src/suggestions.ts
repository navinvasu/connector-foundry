// Fix suggestions (HK-09): from evidence the product already holds, a model
// proposes edits to the text agents read (tool descriptions, when to use
// a tool, argument descriptions). Every suggestion names its evidence and
// stays a proposal until a person accepts it.

import { one, q, exec, J, jb, uid, withTx } from './db.js';
import { extractJson, type LlmClient } from './llm/index.js';
import { redactValue } from './redact.js';

export const SUGGESTION_FIELDS = ['description', 'eligible_use', 'ineligible_use', 'param_description'] as const;
export type SuggestionField = typeof SUGGESTION_FIELDS[number];

export interface ToolForSuggestions {
  id: string;
  name: string;
  description: string | null;
  eligible_use: string | null;
  ineligible_use: string | null;
  input_schema: unknown;
}

export interface Evidence {
  ref: string;
  tool?: string;
  kind: 'review_item' | 'eval_failure' | 'agent_failure';
  summary: string;
}

export interface Suggestion {
  tool_id: string;
  tool: string;
  field: SuggestionField;
  param: string | null;
  before: string | null;
  after: string;
  rationale: string;
  evidence: string[];
}

function paramsOf(tool: ToolForSuggestions): Record<string, { description?: string }> {
  const schema = J.parse<{ properties?: Record<string, { description?: string }> }>(tool.input_schema, {});
  return schema.properties ?? {};
}

/** The project's current evidence: open review items, the latest run's failures. */
export async function gatherEvidence(projectId: string): Promise<Evidence[]> {
  const out: Evidence[] = [];
  const reviews = await q<any>(
    `SELECT r.id, r.title, r.recommendation, t.name AS tool FROM review_items r
       LEFT JOIN canonical_tools t ON t.id = r.tool_id
      WHERE r.project_id = $1 AND r.status = 'open' ORDER BY r.created_at DESC LIMIT 30`, [projectId]);
  for (const r of reviews) {
    out.push({ ref: `review:${r.id}`, tool: r.tool ?? undefined, kind: 'review_item', summary: `${r.title}. Recommendation: ${r.recommendation}` });
  }
  const run = await one<any>(
    `SELECT id FROM eval_runs WHERE project_id = $1 AND finished_at IS NOT NULL ORDER BY started_at DESC LIMIT 1`, [projectId]);
  if (run) {
    const failures = await q<any>(
      `SELECT e.id, e.suite, e.scenario, e.detail, t.name AS tool FROM eval_results e
         LEFT JOIN canonical_tools t ON t.id = e.tool_id
        WHERE e.eval_run_id = $1 AND e.passed = false LIMIT 30`, [run.id]);
    for (const f of failures) {
      const detail = JSON.stringify(redactValue(J.parse(f.detail, {}))).slice(0, 300);
      out.push({ ref: `eval:${f.id}`, tool: f.tool ?? undefined, kind: 'eval_failure', summary: `${f.suite}/${f.scenario} failed: ${detail}` });
    }
    const agentFailures = await q<any>(
      `SELECT id, prompt, checks, transcript FROM eval_agent_results WHERE eval_run_id = $1 AND passed = false LIMIT 15`, [run.id]);
    for (const a of agentFailures) {
      const checks = J.parse<Array<{ name: string; passed: boolean; detail?: string }>>(a.checks, [])
        .filter((c) => !c.passed).map((c) => `${c.name}${c.detail ? ` (${c.detail})` : ''}`).join('; ');
      const transcript = J.parse<{ steps?: Array<{ toolCalls?: Array<{ name: string; args: unknown; result?: { ok?: boolean; error?: string } }> }> }>(a.transcript, {});
      const calls = (transcript.steps ?? []).flatMap((s) => s.toolCalls ?? [])
        .map((c) => `${c.name}(${JSON.stringify(c.args).slice(0, 120)})${c.result?.ok === false ? ` → ${c.result.error ?? 'failed'}` : ''}`)
        .join(', ');
      out.push({
        ref: `agent:${a.id}`, kind: 'agent_failure',
        summary: `Agent task "${String(a.prompt).slice(0, 200)}" failed: ${checks}. Calls: ${calls || 'none'}`,
      });
    }
  }
  return out;
}

export const SUGGESTION_SYSTEM_PROMPT = [
  'You improve how an API\'s tools are described to AI agents.',
  'From the evidence, propose specific edits that would stop agents from picking the wrong tool,',
  'sending invalid arguments, or misreading results. Edit only these fields: description,',
  'eligible_use (when to use the tool), ineligible_use (when not to), param_description (one argument).',
  'Each edit must cite the evidence refs it fixes. Write the full new text, plain and factual.',
  'Never invent API behavior the evidence and current text do not support.',
  'Reply with JSON only: an array of {"tool": string, "field": string, "param": string|null,',
  '"after": string, "rationale": string, "evidence": string[]}.',
].join(' ');

function toolBrief(t: ToolForSuggestions): string {
  const params = Object.entries(paramsOf(t))
    .map(([n, p]) => `    ${n}: ${(p.description ?? '').replace(/\s+/g, ' ').slice(0, 200)}`).join('\n');
  return [
    `- ${t.name}`,
    `  description: ${(t.description ?? '').replace(/\s+/g, ' ').slice(0, 400)}`,
    `  eligible_use: ${t.eligible_use ?? ''}`,
    `  ineligible_use: ${t.ineligible_use ?? ''}`,
    `  params:\n${params || '    (none)'}`,
  ].join('\n');
}

/** Ask the model for edits and keep only valid ones (real tool, real field/param, real change). */
export async function proposeSuggestions(llm: LlmClient, tools: ToolForSuggestions[], evidence: Evidence[]): Promise<Suggestion[]> {
  if (evidence.length === 0 || tools.length === 0) return [];
  const res = await llm.chat({
    system: SUGGESTION_SYSTEM_PROMPT,
    messages: [{
      role: 'user',
      content: `Tools:\n${tools.map(toolBrief).join('\n')}\n\nEvidence:\n${evidence
        .map((e) => `[${e.ref}]${e.tool ? ` (${e.tool})` : ''} ${e.summary}`).join('\n')}`,
    }],
    maxTokens: 3000,
    temperature: 0.2,
  });
  const raw = extractJson<unknown>(res.text);
  const byName = new Map(tools.map((t) => [t.name, t]));
  const refs = new Set(evidence.map((e) => e.ref));
  const out: Suggestion[] = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    if (!item || typeof item !== 'object') continue;
    const s = item as Record<string, unknown>;
    const tool = byName.get(String(s.tool ?? ''));
    const field = String(s.field ?? '') as SuggestionField;
    const after = typeof s.after === 'string' ? s.after.trim().slice(0, 4000) : '';
    if (!tool || !(SUGGESTION_FIELDS as readonly string[]).includes(field) || !after) continue;
    let param: string | null = null;
    let before: string | null;
    if (field === 'param_description') {
      param = typeof s.param === 'string' ? s.param : null;
      const params = paramsOf(tool);
      if (!param || !(param in params)) continue;
      before = params[param]?.description ?? null;
    } else {
      before = (tool as unknown as Record<string, string | null>)[field] ?? null;
    }
    if ((before ?? '').trim() === after) continue;
    out.push({
      tool_id: tool.id, tool: tool.name, field, param, before, after,
      rationale: typeof s.rationale === 'string' ? s.rationale.trim().slice(0, 1000) : '',
      evidence: (Array.isArray(s.evidence) ? s.evidence : []).map(String).filter((r) => refs.has(r)).slice(0, 10),
    });
  }
  return out.slice(0, 20);
}

/** Store proposals; earlier open proposals for the project are superseded. */
export async function storeSuggestions(projectId: string, suggestions: Suggestion[], model: string): Promise<string[]> {
  const ids: string[] = [];
  await withTx(async (t) => {
    await t.query(`UPDATE fix_suggestions SET status = 'superseded' WHERE project_id = $1 AND status = 'proposed'`, [projectId]);
    for (const s of suggestions) {
      const id = uid();
      ids.push(id);
      await t.query(
        `INSERT INTO fix_suggestions (id, project_id, tool_id, field, param, before_text, after_text, rationale, evidence, model)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [id, projectId, s.tool_id, s.field, s.param, s.before, s.after, s.rationale, jb(s.evidence), model]);
    }
  });
  return ids;
}

/** Set one argument's description inside a stored input schema. */
export function withParamDescription(inputSchema: unknown, param: string, description: string): Record<string, unknown> {
  const schema = J.parse<Record<string, any>>(inputSchema, {});
  const properties = { ...(schema.properties ?? {}) };
  if (!(param in properties)) throw new Error(`Unknown argument "${param}"`);
  properties[param] = { ...properties[param], description };
  return { ...schema, properties };
}

/**
 * Accept: apply the edit to the tool and send it back to `candidate`, so
 * the next approval bumps its version and a new release carries it.
 * `after` lets the reviewer adjust the text before accepting.
 */
export async function acceptSuggestion(projectId: string, suggestionId: string, decidedBy: string | null, after?: string) {
  const s = await one<any>(
    `SELECT * FROM fix_suggestions WHERE id = $1 AND project_id = $2`, [suggestionId, projectId]);
  if (!s) return { status: 404 as const };
  if (s.status !== 'proposed') return { status: 409 as const, current: s.status as string };
  const text = (after ?? s.after_text).trim();
  await withTx(async (t) => {
    if (s.field === 'param_description') {
      const tool = (await t.query(`SELECT input_schema FROM canonical_tools WHERE id = $1`, [s.tool_id])).rows[0];
      await t.query(
        `UPDATE canonical_tools SET input_schema = $1, status = 'candidate', updated_at = now() WHERE id = $2`,
        [jb(withParamDescription(tool?.input_schema, s.param, text)), s.tool_id]);
    } else {
      // field is one of the fixed column names (validated on the way in).
      const column = (SUGGESTION_FIELDS as readonly string[]).includes(s.field) ? s.field : null;
      if (!column) throw new Error('Invalid suggestion field');
      await t.query(
        `UPDATE canonical_tools SET ${column} = $1, status = 'candidate', updated_at = now() WHERE id = $2`, [text, s.tool_id]);
    }
    await t.query(
      `UPDATE fix_suggestions SET status = 'accepted', after_text = $1, decided_by = $2, decided_at = now() WHERE id = $3`,
      [text, decidedBy, suggestionId]);
  });
  return { status: 200 as const };
}
