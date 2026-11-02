// Pipeline stages that run on the background job queue (see queue.ts).
// Each stage reads its inputs from PostgreSQL — never from in-memory caches.

import { q, withTx, jb, uid, audit } from './db.js';
import { parseOpenApi } from './openapi.js';
import { compileOperation } from './compiler.js';

export type ProgressFn = (done: number, total: number, note: string) => void | Promise<void>;

/**
 * Compile a project's imported operations into canonical tool drafts.
 * Returns the number of tools created. Throws when there is nothing to compile.
 */
export async function compileProject(
  projectId: string,
  onProgress?: ProgressFn,
): Promise<{ tools_created: number; tool_ids: string[] }> {
  const ops = (await q(
    `SELECT * FROM operations WHERE project_id = $1 AND status = 'imported'`, [projectId],
  )) as any[];
  if (ops.length === 0) throw new Error('No imported operations to compile');

  // Re-parse every imported spec snapshot from the database — no in-memory cache.
  const sources = (await q(
    `SELECT location, spec_body FROM api_sources WHERE project_id = $1 ORDER BY created_at`, [projectId],
  )) as any[];
  const specs = sources
    .filter((s) => s.spec_body)
    .map((s) => ({ location: s.location, spec: s.spec_body }));
  if (specs.length === 0) {
    throw new Error('No import specs found for this project. Import a source first.');
  }

  const total = specs.reduce((n, { location, spec }) => n + parseOpenApi(spec, location).operations.length, 0);
  let done = 0;

  // Dedupe (uq_canonical_tools_project_name): tool names derive
  // deterministically from the operation, so a re-compile meets the tools it
  // already created. Those are skipped — never a second draft row, and never
  // a silent overwrite of an approved/tested/released tool.
  const existingNames = new Set(
    ((await q(`SELECT name FROM canonical_tools WHERE project_id = $1`, [projectId])) as any[])
      .map((r) => r.name),
  );

  const created = await withTx(async (t) => {
    const ids: string[] = [];
    for (const { location, spec } of specs) {
      const parsedSpec = parseOpenApi(spec, location);
      for (const op of parsedSpec.operations) {
        const tool = compileOperation(op, parsedSpec.baseUrl, location ?? 'unknown-source', parsedSpec.securitySchemeTypes, parsedSpec.securitySchemeDetails);
        done += 1;
        await onProgress?.(done, total, `Compiling ${op.method} ${op.path}`);
        if (existingNames.has(tool.name)) continue;
        const toolId = uid();
        // Backstop for the pre-check above: a concurrent compile that wins
        // the race collides here instead of 500ing — and with no row there
        // are no rules to attach, so the loop moves on.
        const inserted = await t.query(
          `INSERT INTO canonical_tools
           (id, project_id, name, description, purpose, eligible_use, ineligible_use,
            input_schema, output_schema, upstream, effect_classes, confirmation_required,
            idempotent, credential_mode, required_scopes, provenance, confidence, version, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, 1, 'candidate')
           ON CONFLICT DO NOTHING`,
          [toolId, projectId, tool.name, tool.description, tool.purpose, tool.eligible_use,
           tool.ineligible_use, jb(tool.input_schema), jb(tool.output_schema), jb(tool.upstream),
           jb(tool.effect_classes), tool.confirmation_required, tool.idempotent,
           tool.credential_mode, jb(tool.required_scopes), jb(tool.provenance), tool.confidence]);
        if ((inserted?.rowCount ?? 0) === 0) continue;
        for (const r of tool.recovery_rules) {
          await t.query(
            `INSERT INTO tool_recovery_rules
             (id, tool_id, tool_version, condition, detection_rule, behavior, recovery_action,
              max_attempts, backoff_ms, user_message)
             VALUES ($1, $2, 1, $3, $4, $5, $6, $7, $8, $9)`,
            [uid(), toolId, r.condition, jb(r.detection_rule), r.behavior,
             r.recovery_action, r.max_attempts, r.backoff_ms, r.user_message]);
        }
        ids.push(toolId);
        existingNames.add(tool.name);
      }
    }
    await t.query(`UPDATE operations SET status = 'normalized' WHERE project_id = $1 AND status = 'imported'`,
      [projectId]);
    return ids;
  });

  await audit(projectId, 'tools.compiled', 'project', projectId, { tools: created.length });
  return { tools_created: created.length, tool_ids: created };
}
