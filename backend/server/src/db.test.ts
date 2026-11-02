import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock node-postgres before db.ts creates its pool.
// vi.hoisted runs before the hoisted vi.mock factory below.
const { queryMock, connectMock, clientQueryMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  clientQueryMock: vi.fn(),
  connectMock: vi.fn(),
}));
connectMock.mockImplementation(async () => ({
  query: clientQueryMock,
  release: vi.fn(),
}));

vi.mock('pg', () => {
  // Regular function so `new Pool()` works.
  function MockPool(this: any) {
    this.query = queryMock;
    this.connect = connectMock;
    this.on = vi.fn();
    this.end = vi.fn();
  }
  return { default: { Pool: MockPool } };
});

import { applySchema, audit } from './db.js';

beforeEach(() => {
  vi.clearAllMocks();
  queryMock.mockResolvedValue({ rows: [] });
  clientQueryMock.mockResolvedValue({ rows: [] });
});

describe('applySchema (single schema file, no migrations)', () => {
  it('applies schema/schema.sql in one transaction with final-state shapes', async () => {
    await applySchema();
    const stmts = clientQueryMock.mock.calls.map(([t]: any[]) => String(t));
    expect(stmts[0]).toBe('BEGIN');
    expect(stmts[stmts.length - 1]).toBe('COMMIT');
    const sql = stmts.join('\n');
    // Squashed final state (001–019): later alters are folded into CREATE TABLE.
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS projects');
    expect(sql).toContain('capture_prompts');
    expect(sql).toContain('invite_token_hash');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS eval_agent_tasks');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS fix_suggestions');
    // Removed shapes must not come back: no plaintext invite token, no is_demo.
    expect(sql).not.toMatch(/invite_token\s+TEXT UNIQUE/);
    expect(sql).not.toContain('is_demo');
    // No ledger: nothing records versions.
    expect(sql).not.toContain('schema_migrations');
  });

  it('refuses a legacy migration-era database with reset instructions', async () => {
    queryMock.mockImplementation(async (text: string) => {
      if (String(text).includes('schema_migrations')) return { rows: [{ has_ledger: true, stale_shape: false }] };
      return { rows: [] };
    });
    await expect(applySchema()).rejects.toThrow(/predates the single-schema layout.*docker compose down -v/);
    expect(clientQueryMock).not.toHaveBeenCalled();
  });

  it('fails loudly and rolls back when the schema does not apply', async () => {
    clientQueryMock.mockImplementation(async (text: string) => {
      if (String(text).includes('CREATE TABLE')) throw new Error('syntax error at or near "TABL"');
      return { rows: [] };
    });
    await expect(applySchema()).rejects.toThrow(/schema apply failed and was rolled back/);
    const stmts = clientQueryMock.mock.calls.map(([t]: any[]) => String(t));
    expect(stmts).toContain('ROLLBACK');
  });
});

// ─── DP-05: audit() redacts metadata before it is persisted ───────────────

describe('audit (DP-05 redaction)', () => {
  it('stores metadata with PII and secrets redacted, benign fields intact', async () => {
    await audit('p1', 'test.action', 'project', 'e1', {
      email: 'ada@example.com',
      note: 'contact ada@example.com, key sk_live_TESTKEY1',
      count: 2,
      ok: true,
    });
    const call = queryMock.mock.calls.find(([t]: any[]) => String(t).includes('INSERT INTO audit_events'));
    expect(call).toBeTruthy();
    const metadata = JSON.parse(call![1][5] as string);
    expect(metadata.email).toBe('REDACTED');
    expect(metadata.note).toBe('contact REDACTED, key REDACTED');
    expect(metadata.count).toBe(2);
    expect(metadata.ok).toBe(true);
  });
});
