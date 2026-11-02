// Drift detection routes (TE-03) — the Operate "Drift alerts" surface.
//
// GET  /v1/projects/:id/drift/alerts?status=open|resolved|all — drift alerts (BE-09 read gate)
// GET  /v1/projects/:id/drift/checks                        — recent drift checks with per-tool summaries
// POST /v1/projects/:id/drift/check                         — enqueue a manual drift check (owner/editor, 202)

import { Router } from 'express';
import { q, J } from '../db.js';
import { asyncHandler, HttpError } from '../errors.js';
import { requireProjectRead, requireProjectRole } from '../auth.js';
import { enqueueJob } from '../queue.js';
import { prodReleaseFor } from '../drift.js';
import {
  parsePagination, paginationError, buildPage, keysetClause, type Cursor,
} from '../paginate.js';

export const driftRouter = Router();

// pg returns JSONB as objects; TEXT-era rows come back as strings —
// J.parse accepts both (same rule as the SE-04 export).
function parseFields<T extends Record<string, any>>(row: T, fields: string[]): T {
  const out: Record<string, any> = { ...row };
  for (const f of fields) out[f] = J.parse(row[f], null);
  return out as T;
}

const serializeAlert = (r: Record<string, any>) => parseFields(r, ['evidence']);
const serializeCheck = (r: Record<string, any>) => parseFields(r, ['summary']);

async function listAlerts(projectId: string, status: string, limit: number, cursor: Cursor | null) {
  const { clause, params } = keysetClause({
    cursor, direction: 'DESC', keyCol: 'last_seen_at', idCol: 'id', paramStart: 2,
  });
  const args: unknown[] = [projectId, ...params];
  let sql = `SELECT * FROM drift_alerts WHERE project_id = $1${clause}`;
  if (status !== 'all') {
    sql += ` AND status = $${args.length + 1}`;
    args.push(status);
  }
  sql += ` ORDER BY last_seen_at DESC, id DESC LIMIT $${args.length + 1}`;
  args.push(limit + 1);
  return (await q(sql, args)) as Record<string, any>[];
}

async function listChecks(projectId: string, limit: number, cursor: Cursor | null) {
  const { clause, params } = keysetClause({
    cursor, direction: 'DESC', keyCol: 'started_at', idCol: 'id', paramStart: 2,
  });
  const args: unknown[] = [projectId, ...params];
  const sql =
    `SELECT * FROM drift_checks WHERE project_id = $1${clause}` +
    ` ORDER BY started_at DESC, id DESC LIMIT $${args.length + 1}`;
  args.push(limit + 1);
  return (await q(sql, args)) as Record<string, any>[];
}

driftRouter.get('/:id/drift/alerts', requireProjectRead(), asyncHandler(async (req, res) => {
  const pg = parsePagination(req.query as Record<string, any>);
  if (!pg.ok) return paginationError(res, pg.fields);
  const status = String(req.query.status ?? 'open');
  if (!['open', 'resolved', 'all'].includes(status)) {
    throw new HttpError(400, 'invalid_request', 'status must be open, resolved, or all');
  }
  const rows = await listAlerts(req.params.id, status, pg.limit, pg.cursor);
  const page = buildPage(rows, pg.limit, 'last_seen_at', 'id');
  res.json({
    alerts: page.items.map(serializeAlert),
    pagination: page.meta,
    // DP-07 pattern: the console gates the "Run check now" button on this;
    // the POST route's requireProjectRole is the real gate.
    caller_role: req.auth?.isPlatformAdmin ? 'owner' : (req.customer?.role ?? null),
  });
}));

driftRouter.get('/:id/drift/checks', requireProjectRead(), asyncHandler(async (req, res) => {
  const pg = parsePagination(req.query as Record<string, any>);
  if (!pg.ok) return paginationError(res, pg.fields);
  const rows = await listChecks(req.params.id, pg.limit, pg.cursor);
  const page = buildPage(rows, pg.limit, 'started_at', 'id');
  res.json({ checks: page.items.map(serializeCheck), pagination: page.meta });
}));

driftRouter.post('/:id/drift/check', requireProjectRole(['owner', 'editor']), asyncHandler(async (req, res, next) => {
  const projectId = req.params.id;
  // Drift checks compare against the prod release's frozen tools — with no
  // prod release there is nothing to compare, so refuse loudly instead of
  // recording a misleading clean check.
  const release = await prodReleaseFor(projectId);
  if (!release) {
    throw new HttpError(409, 'drift_no_prod_release',
      'Drift checks need a prod release — promote a release to prod first.');
  }
  try {
    const { job, deduplicated } = await enqueueJob('drift', projectId, req.auth?.userId);
    res.status(202).json({ job, deduplicated });
  } catch (e) {
    next(e);
  }
}));
