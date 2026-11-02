// Keyset (cursor) pagination for list endpoints (BE-08).
//
// Convention across the control-plane API:
//   GET /v1/.../things?limit=50&cursor=<opaque>
// - `limit`  — max items per page; defaults to 50, clamped to MAX_LIMIT.
// - `cursor` — opaque page token from the previous response's
//              `pagination.next_cursor`; `null` means there is no next page.
// - Ordering is stable (time, id) so pages never skip or repeat rows, even
//   as new rows are inserted between requests.
import type { Response } from 'express';

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 100;

/** Decoded cursor: sort-key value + row id tiebreaker. */
export interface Cursor {
  /** Sort-key value (ISO timestamp, or the tool name for name-ordered lists). */
  t: string;
  /** Row id tiebreaker. */
  i: string;
}

export interface PaginationMeta {
  limit: number;
  next_cursor: string | null;
  has_more: boolean;
}

type ParseResult =
  | { ok: true; limit: number; cursor: Cursor | null }
  | { ok: false; fields: Record<string, string> };

/** Parse `?limit=` / `?cursor=` from an Express query object. */
export function parsePagination(query: Record<string, any>): ParseResult {
  let limit = DEFAULT_LIMIT;
  const rawLimit = query.limit;
  if (rawLimit !== undefined && rawLimit !== '') {
    const n = Number(rawLimit);
    if (!Number.isFinite(n) || Math.floor(n) < 1) {
      return { ok: false, fields: { limit: 'limit must be a positive integer' } };
    }
    limit = Math.min(MAX_LIMIT, Math.floor(n));
  }
  const rawCursor = query.cursor;
  if (rawCursor === undefined || rawCursor === '') {
    return { ok: true, limit, cursor: null };
  }
  try {
    const decoded = Buffer.from(String(rawCursor), 'base64url').toString('utf8');
    const c = JSON.parse(decoded) as unknown;
    if (typeof c !== 'object' || c === null) throw new Error('shape');
    const { t, i } = c as { t?: unknown; i?: unknown };
    if (typeof t !== 'string' || typeof i !== 'string' || t === '' || i === '') {
      throw new Error('shape');
    }
    // Timestamps must parse; names (tools list) are accepted as-is.
    return { ok: true, limit, cursor: { t, i } };
  } catch {
    return { ok: false, fields: { cursor: 'cursor is invalid or expired; start from the first page' } };
  }
}

/** Encode a sort-key value + row id into an opaque page token. */
export function encodeCursor(time: string | Date, id: string): string {
  const t = time instanceof Date ? time.toISOString() : time;
  return Buffer.from(JSON.stringify({ t, i: id })).toString('base64url');
}

/** 400 for bad pagination input — same envelope as validateBody (BE-04). */
export function paginationError(res: Response, fields: Record<string, string>): Response {
  return res.status(400).json({ error: 'invalid_request', code: 'invalid_pagination', fields });
}

export interface KeysetOptions {
  cursor: Cursor | null;
  /** 'DESC' for newest-first lists, 'ASC' for name-ordered lists. */
  direction: 'ASC' | 'DESC';
  /** Qualified sort column, e.g. 'p.created_at'. */
  keyCol: string;
  /** Qualified id column for the tiebreaker, e.g. 'p.id'. */
  idCol: string;
  /** Next $ placeholder index (1-based) after the caller's own params. */
  paramStart: number;
}

/**
 * Build the keyset filter fragment to append inside an existing WHERE clause.
 * The caller's query must ORDER BY keyCol, idCol in `direction` and
 * LIMIT (limit + 1) so `buildPage` can detect a following page.
 */
export function keysetClause(opts: KeysetOptions): { clause: string; params: unknown[] } {
  if (!opts.cursor) return { clause: '', params: [] };
  const op = opts.direction === 'DESC' ? '<' : '>';
  return {
    clause: ` AND (${opts.keyCol}, ${opts.idCol}) ${op} ($${opts.paramStart}, $${opts.paramStart + 1})`,
    params: [opts.cursor.t, opts.cursor.i],
  };
}

export interface Page<T> {
  items: T[];
  meta: PaginationMeta;
}

/**
 * Slice `limit + 1` fetched rows into page items + pagination metadata.
 * `timeKey` is the raw row field holding the sort-key value; `idKey` the id.
 */
export function buildPage<T extends Record<string, any>>(
  rows: T[], limit: number, timeKey: string, idKey: string,
): Page<T> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  return {
    items,
    meta: {
      limit,
      has_more: hasMore,
      next_cursor: hasMore && last ? encodeCursor(last[timeKey], String(last[idKey])) : null,
    },
  };
}
