import { Router } from 'express';
import YAML from 'yaml';
import { one, q, exec, withTx, J, jb, uid, audit } from '../db.js';
import { parseOpenApi, fetchSpec, buildInventory, docScore, classifyEffect, isPostmanCollection } from '../openapi.js';
import { validateSpec, withLineNumbers, SpecValidationError } from '../spec-validate.js';
import { requireProjectRole, requireProjectRead } from '../auth.js';
import { validateBody, importSourceSchema, reviewItemSchema } from '../validate.js';
import { asyncHandler, HttpError } from '../errors.js';
import { enqueueJob } from '../queue.js';

export const sourcesRouter = Router();

/** The suggested fix shown on each review item. AUTH/ERROR findings are
 *  informational: no user action resolves them, so the text says that and
 *  the queue asks for an acknowledgement instead of a resolution. */
export function findingRecommendation(f: { code: string; severity: string }): string {
  switch (f.code) {
    case 'HOST':
      return 'Add a `servers` entry with the API base URL to the spec and re-import. Until then the sandbox prober cannot reach this API.';
    case 'AUTH':
      return 'Informational — no fix needed if this API is public. If it does require a key, declare it under securitySchemes in the spec and re-import, then store the key in Credentials.';
    case 'SCHEMA':
      return 'Open the affected operation in Tools and write a one-line description of what it returns (or add summary/description in the spec and re-import) so agents know when to call it.';
    case 'ERROR':
      return 'Informational — nothing to fix here. ConnectorFoundry infers recovery rules from live probing in Evaluate; optionally document 4xx/5xx responses in the spec at the source.';
    case 'EFFECT':
      return f.severity === 'blocker'
        ? 'Decide in Tools: confirm the destructive effect class and its confirmation rule, then approve. Unapproved destructive tools cannot ship.'
        : 'Confirm the effect class and confirmation rule for this operation in Tools, then approve it.';
    default:
      return f.severity === 'blocker'
        ? 'Resolve before release — this blocks the affected path.'
        : 'Review and confirm, or dismiss with a reason.';
  }
}

/** Parse pasted/uploaded spec text — JSON first, then YAML. */
function parseTextSpec(text: string): any {
  const t = text.trim();
  if (!t) throw new Error('Empty spec text');
  try {
    return JSON.parse(t);
  } catch {
    try {
      return YAML.parse(t);
    } catch (e: any) {
      throw new Error(`Spec text is neither JSON nor YAML: ${e?.message ?? e}`);
    }
  }
}

// POST /v1/projects/:id/sources — {type, payload}
//   openapi_url:  payload = spec URL (server fetches it; JSON only)
//   openapi_json: payload = parsed spec object (JSON)
//   openapi_text: payload = raw spec text (JSON or YAML; from file upload/paste)
//   postman_url / postman_json / postman_text: a Postman Collection v2.1
//     (IA-02), by URL, parsed object, or raw text. Collections are also
//     auto-detected under the openapi_* types so an uploaded file just works.
sourcesRouter.post('/:id/sources', requireProjectRole(['owner', 'editor']), validateBody(importSourceSchema), asyncHandler(async (req, res) => {
    // requireProjectRole already 404'd unknown projects and 403'd non-editors.
    const project = (await one(`SELECT * FROM projects WHERE id = $1`, [req.params.id])) as any;

    const { type, payload } = req.body as { type: 'openapi_url' | 'openapi_json' | 'openapi_text' | 'postman_url' | 'postman_json' | 'postman_text'; payload: unknown };
    // Fetch + parse phase: failures are the caller's spec/URL to fix → 400 with
    // the actionable message. Everything below this block (DB writes) is
    // unexpected → central 500 via asyncHandler.
    let parsed: ReturnType<typeof parseOpenApi>;
    let findings: ReturnType<typeof buildInventory>['findings'];
    let spec: any;
    let location: string;
    let sourceType: string;
    let rawText: string | null = null;
    try {
      if (type === 'openapi_url' || type === 'postman_url') {
        location = String(payload);
        sourceType = type === 'postman_url' ? 'postman' : 'openapi_url';
        spec = await fetchSpec(location);
      } else if (type === 'openapi_json' || type === 'postman_json') {
        spec = payload;
        location = 'inline-upload';
        sourceType = 'openapi_file';
      } else if (type === 'openapi_text' || type === 'postman_text') {
        rawText = String(payload ?? '');
        spec = parseTextSpec(rawText);
        location = 'file-upload';
        sourceType = 'openapi_file';
      } else {
        // Unreachable: validateBody(importSourceSchema) already rejected bad types.
        throw new HttpError(400, 'spec_parse_error', "type must be 'openapi_url', 'openapi_json', 'openapi_text', 'postman_url', 'postman_json' or 'postman_text'");
      }
      // IA-02: a Postman collection records its real provenance whichever
      // door it arrived through (explicit postman_* type or an upload the
      // parser auto-detects).
      if (isPostmanCollection(spec)) sourceType = 'postman';
      // IA-04: every $ref must resolve inside the document before anything
      // is stored — a dangling ref otherwise degrades silently into a
      // generic object schema and the connector breaks much later.
      const issues = validateSpec(spec);
      if (issues.length > 0) {
        throw new SpecValidationError(rawText ? withLineNumbers(issues, rawText) : issues);
      }
      parsed = parseOpenApi(spec, type === 'openapi_url' || type === 'postman_url' ? location : undefined);
      findings = buildInventory(parsed).findings;
    } catch (e) {
      if (e instanceof HttpError) throw e;
      if (e instanceof SpecValidationError) {
        throw new HttpError(400, 'spec_validation_error', e.message, { issues: e.issues });
      }
      throw new HttpError(400, 'spec_parse_error', e instanceof Error ? e.message : String(e));
    }

    // Dedupe: the source snapshot row is always kept (audit trail of what was
    // imported when), but operations and review items collide on their unique
    // indexes — re-importing the same spec inserts zero new rows instead of
    // duplicating every tool and warning.
    const { sourceId, newOperations } = await withTx(async (t) => {
      const id = uid();
      await t.query(
        `INSERT INTO api_sources (id, project_id, source_type, location, spec_hash, spec_body, fetch_status)
         VALUES ($1, $2, $3, $4, $5, $6, 'ok')`,
        [id, project.id, sourceType, location, parsed.specHash, jb(spec)],
      );
      let fresh = 0;
      for (const op of parsed.operations) {
        const r = await t.query(
          `INSERT INTO operations (id, project_id, source_id, http_method, path, operation_id, summary, base_url, spec_hash, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'imported')
           ON CONFLICT DO NOTHING
           RETURNING id`,
          [uid(), project.id, id, op.method, op.path, op.operationId ?? null,
           op.summary || op.description || '', parsed.baseUrl, parsed.specHash],
        );
        fresh += r?.rows?.length ?? 0;
      }
      // Blocking/warning findings become review items (DEC-01). Each item
      // carries a concrete suggested fix; purely informational findings
      // (no user action exists — AUTH/ERROR below) say so explicitly and are
      // acknowledged, not resolved, in the review queue. An already-open item
      // with the same kind+title survives untouched — no second copy.
      for (const f of findings) {
        await t.query(
          `INSERT INTO review_items (id, project_id, kind, title, evidence, recommendation, status)
           VALUES ($1, $2, $3, $4, $5, $6, 'open')
           ON CONFLICT DO NOTHING`,
          [uid(), project.id, f.severity === 'blocker' ? 'risk' : 'ambiguity', f.title,
           jb({ code: f.code, detail: f.detail, operationRef: f.operationRef ?? null }),
           findingRecommendation(f)],
        );
      }
      return { sourceId: id, newOperations: fresh };
    });

    await audit(project.id, 'source.imported', 'api_source', sourceId,
      { operations: parsed.operations.length, new_operations: newOperations, findings: findings.length });

    // Compilation starts with the import — the dashboard's "Compiling"
    // stage is a running job, not a dead end. Idempotent per project:
    // a re-import while a compile runs reuses the running job. A re-import
    // that adds nothing new (same spec again) skips the compile entirely —
    // there is nothing to build, and the tools stay exactly as they are.
    const compileJob = newOperations > 0
      ? (await enqueueJob('compile', project.id, req.auth?.userId ?? null)).job
      : null;

    res.status(201).json({
      compile_job: compileJob ? { id: compileJob.id, status: compileJob.status } : null,
      source: { id: sourceId, title: parsed.title, version: parsed.version, base_url: parsed.baseUrl,
                operations: parsed.operations.length, schemas: parsed.schemaCount,
                security_schemes: parsed.securitySchemes },
      inventory: {
        operations: parsed.operations.map((op) => ({
          method: op.method, path: op.path, summary: op.summary,
          effect: classifyEffect(op.method, op.path),
          doc_score: docScore(op),
          deprecated: op.deprecated,
          auth_schemes: op.authSchemes,
        })),
        findings,
      },
    });
}));

// BE-09: the three reads below are tenant-scoped via requireProjectRead.
sourcesRouter.get('/:id/sources', requireProjectRead(), asyncHandler(async (req, res) => {
  const rows = await q(`SELECT id, project_id, source_type, location, spec_hash, fetch_status, fetch_error, created_at
                        FROM api_sources WHERE project_id = $1 ORDER BY created_at DESC`, [req.params.id]);
  res.json({ sources: rows });
}));

sourcesRouter.get('/:id/operations', requireProjectRead(), asyncHandler(async (req, res) => {
  const rows = await q(`SELECT * FROM operations WHERE project_id = $1 ORDER BY http_method, path`, [req.params.id]);
  res.json({ operations: rows });
}));

sourcesRouter.get('/:id/review', requireProjectRead(), asyncHandler(async (req, res) => {
  const rows = await q(`SELECT * FROM review_items WHERE project_id = $1 ORDER BY created_at`, [req.params.id]);
  res.json({ review_items: rows.map((r: any) => ({ ...r, evidence: J.parse(r.evidence, {}) })) });
}));

sourcesRouter.patch('/review/:itemId', requireProjectRole(['owner', 'editor'], 'reviewItemParam'), validateBody(reviewItemSchema), asyncHandler(async (req, res) => {
  const { status } = req.body as { status: string };
  const n = await exec(`UPDATE review_items SET status = $1, resolved_at = now() WHERE id = $2`,
    [status, req.params.itemId]);
  if (n === 0) return res.status(404).json({ error: 'Review item not found' });
  res.json({ ok: true });
}));
