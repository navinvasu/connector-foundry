// PostgreSQL persistence for the Connector Foundry server.
// Local:  docker compose up -d in projects/connector-foundry/backend
//          (DATABASE_URL=postgres://postgres:postgres@localhost:5432/connector_foundry)
// Hosted: the lite stack's Postgres — only DATABASE_URL changes.
// Schema: schema/schema.sql (single final-state file, no migrations — no
// database has been deployed yet), applied automatically on boot.

import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from './logger.js';
import { redactValue } from './redact.js';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/connector_foundry',
  max: 10,
});

pool.on('error', (err) => {
  logger.error({ msg: 'idle pool client error', error: err.message });
});

/** Run a query, return rows. */
export async function q<T = any>(text: string, params: unknown[] = []): Promise<T[]> {
  const r = await pool.query(text, params as any[]);
  return r.rows as T[];
}

/** Run a query, return the first row (or undefined). */
export async function one<T = any>(text: string, params: unknown[] = []): Promise<T | undefined> {
  const rows = await q<T>(text, params);
  return rows[0];
}

/** Run a statement, return affected row count. */
export async function exec(text: string, params: unknown[] = []): Promise<number> {
  const r = await pool.query(text, params as any[]);
  return r.rowCount ?? 0;
}

/** Run fn inside a transaction; rolls back on throw. */
export async function withTx<T>(fn: (t: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/** Apply the single schema file (schema/schema.sql) in one transaction.
 *
 * No migration history exists: no database has been deployed, so the former
 * migrations/001–019 were squashed into one final-state DDL file. The file
 * is idempotent (IF NOT EXISTS / ON CONFLICT DO NOTHING), so applying it on
 * every boot is safe; a failure rolls back and fails loudly. Once an
 * environment holds real data, schema changes ship as migrations again.
 */
export async function applySchema(): Promise<void> {
  const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'schema', 'schema.sql');
  // Pre-deployment guard: a local database created by the old migration
  // chain can hold an earlier shape (e.g. customer_users without
  // invite_token_hash). CREATE TABLE IF NOT EXISTS would silently keep it
  // and the apply would die on a missing column with no hint. Nothing has
  // been deployed, so the fix is a reset — say so instead of auto-dropping.
  const legacy = await pool.query(
    `SELECT (to_regclass('public.schema_migrations') IS NOT NULL) AS has_ledger,
            (to_regclass('public.customer_users') IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM information_schema.columns
                              WHERE table_schema = 'public'
                                AND table_name = 'customer_users'
                                AND column_name = 'invite_token_hash')) AS stale_shape`,
  );
  const row = legacy.rows[0] as { has_ledger?: boolean; stale_shape?: boolean } | undefined;
  if (row?.has_ledger || row?.stale_shape) {
    throw new Error(
      '[db] this database predates the single-schema layout (D-93) and cannot be upgraded in place. ' +
        'No deployed database exists yet, so reset it: from projects/connector-foundry/backend run ' +
        '`docker compose down -v && docker compose up -d`, then start the server again.',
    );
  }
  try {
    await withTx(async (t) => {
      await t.query(readFileSync(file, 'utf8'));
    });
  } catch (e: any) {
    throw new Error(`[db] schema apply failed and was rolled back: ${e.message}`);
  }
  logger.info({ msg: 'schema up to date' });
}

export function uid(): string {
  return randomUUID();
}

/** Serialize a value for a JSONB column. pg serializes top-level JS arrays
 *  as Postgres array literals (not JSON), so explicit stringify is required. */
export function jb(v: unknown): string | null {
  return v === undefined ? null : JSON.stringify(v);
}

export function now(): string {
  return new Date().toISOString();
}

export const J = {
  /** JSONB columns come back as objects from pg; TEXT-era rows as strings.
   *  Accept both so reads are robust. */
  parse<T>(v: unknown, fallback: T): T {
    if (v === null || v === undefined) return fallback;
    if (typeof v !== 'string') return v as T;
    try {
      return JSON.parse(v) as T;
    } catch {
      return fallback;
    }
  },
  /** Pass objects straight through — pg serializes them into JSONB. */
  str(v: unknown): string {
    return JSON.stringify(v ?? null);
  },
};

export async function audit(
  projectId: string | null,
  action: string,
  entityType: string,
  entityId?: string,
  metadata?: unknown,
) {
  // DP-05: audit rows are a log — metadata is pattern/key redacted at this
  // single choke point so no call site can persist PII or a secret by
  // including it in metadata.
  await exec(
    `INSERT INTO audit_events (id, project_id, action, entity_type, entity_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [uid(), projectId, action, entityType, entityId ?? null, jb(redactValue(metadata ?? null))],
  );
}
