// BE-08: telemetrySummary paginates the recent-events list.
import { createHmac } from 'node:crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./db.js', () => ({
  one: vi.fn(),
  q: vi.fn(),
  exec: vi.fn(),
  J: { parse: (v: any, fb: any) => (v == null ? fb : v) },
  uid: () => 'uid-1',
  audit: vi.fn(),
}));

import { q } from './db.js';
import { telemetrySummary, verifySignature } from './runtime.js';

const qMock = vi.mocked(q);

const byStatus = [{ status: 'ok', n: 5, avg_ms: 120.5 }];
const byTool = [{ tool_name: 'getInvoices', calls: 5, ok_calls: 5, avg_ms: 120.5 }];
const event = (id: string, created_at: string) =>
  ({ id, tool_name: 'getInvoices', status: 'ok', latency_ms: 100, prompt_ref: null, created_at: new Date(created_at) });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('telemetrySummary pagination', () => {
  it('defaults to 50 recent events with no pagination metadata gaps', async () => {
    qMock
      .mockResolvedValueOnce(byStatus)
      .mockResolvedValueOnce([event('e1', '2026-09-28T00:00:00.000Z')])
      .mockResolvedValueOnce(byTool);
    const res = await telemetrySummary('p1');
    expect(res.recent).toHaveLength(1);
    expect(res.pagination).toMatchObject({ limit: 50, has_more: false, next_cursor: null });
    expect(res.by_status).toEqual(byStatus);
    expect(res.by_tool).toEqual(byTool);
    // TE-02: no plan retention → the default 14-day window passes through unlocked.
    expect(res.retention).toEqual({
      retention_days: null, requested_hours: 336, effective_hours: 336, locked: false,
    });
    const [recentSql, recentParams] = qMock.mock.calls[1]!;
    expect(String(recentSql)).toContain('ORDER BY created_at DESC, id DESC');
    // Recent list is windowed too: $2 is the lookback in hours.
    expect(recentParams).toEqual(['p1', 336, 51]);
  });

  it('pages the recent list and encodes next_cursor from the last item', async () => {
    qMock
      .mockResolvedValueOnce(byStatus)
      .mockResolvedValueOnce([
        event('e1', '2026-09-28T00:00:00.000Z'),
        event('e2', '2026-09-27T00:00:00.000Z'),
        event('e3', '2026-09-26T00:00:00.000Z'),
      ])
      .mockResolvedValueOnce(byTool);
    const res = await telemetrySummary('p1', 336, { limit: 2, cursor: null });
    expect(res.recent.map((r: any) => r.id)).toEqual(['e1', 'e2']);
    expect(res.pagination.has_more).toBe(true);
    expect(typeof res.pagination.next_cursor).toBe('string');
    // Cursor decodes to the last served row.
    const decoded = JSON.parse(Buffer.from(res.pagination.next_cursor!, 'base64url').toString('utf8'));
    expect(decoded).toEqual({ t: '2026-09-27T00:00:00.000Z', i: 'e2' });
  });

  it('applies a cursor filter to the recent list', async () => {
    qMock
      .mockResolvedValueOnce(byStatus)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(byTool);
    await telemetrySummary('p1', 336, { limit: 10, cursor: { t: '2026-09-28T00:00:00.000Z', i: 'e1' } });
    const [recentSql, recentParams] = qMock.mock.calls[1]!;
    expect(String(recentSql)).toContain('(created_at, id) < ($3, $4)');
    expect(recentParams).toEqual(['p1', 336, '2026-09-28T00:00:00.000Z', 'e1', 11]);
  });
});

// ─── TE-02: plan retention clamps the window, never an error ───────────────

import { resolveWindowHours, MAX_LOOKBACK_HOURS } from './runtime.js';

describe('resolveWindowHours', () => {
  it('passes through a window inside retention', () => {
    expect(resolveWindowHours(336, 90)).toEqual({
      retention_days: 90, requested_hours: 336, effective_hours: 336, locked: false,
    });
  });

  it('clamps a month-4 Starter query to 90 days and marks it locked', () => {
    expect(resolveWindowHours(120 * 24, 90)).toEqual({
      retention_days: 90, requested_hours: 2880, effective_hours: 2160, locked: true,
    });
  });

  it('caps at 12 months even when retention is longer', () => {
    expect(resolveWindowHours(500 * 24, 730)).toEqual({
      retention_days: 730, requested_hours: 12000, effective_hours: MAX_LOOKBACK_HOURS, locked: true,
    });
  });

  it('treats a missing plan row as no clamp beyond the architecture cap', () => {
    expect(resolveWindowHours(336, null)).toEqual({
      retention_days: null, requested_hours: 336, effective_hours: 336, locked: false,
    });
  });
});

describe('telemetrySummary retention enforcement', () => {
  it('queries every panel with the clamped window and reports locked', async () => {
    qMock
      .mockResolvedValueOnce(byStatus)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(byTool);
    const res = await telemetrySummary('p1', 120 * 24, undefined, 90);
    expect(res.retention).toEqual({
      retention_days: 90, requested_hours: 2880, effective_hours: 2160, locked: true,
    });
    // by_status and by_tool both bind the clamped 90-day window.
    expect(qMock.mock.calls[0]![1]).toEqual(['p1', 2160]);
    expect(qMock.mock.calls[2]![1]).toEqual(['p1', 2160]);
    // …and the recent list is bounded by the same window.
    expect(String(qMock.mock.calls[1]![0])).toContain("created_at >= now() - ($2 * interval '1 hour')");
    expect(qMock.mock.calls[1]![1]).toEqual(['p1', 2160, 51]);
  });

  it('does not lock a window the plan covers', async () => {
    qMock
      .mockResolvedValueOnce(byStatus)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(byTool);
    const res = await telemetrySummary('p1', 30 * 24, undefined, 90);
    expect(res.retention.locked).toBe(false);
    expect(res.retention.effective_hours).toBe(720);
    expect(qMock.mock.calls[0]![1]).toEqual(['p1', 720]);
  });
});

// ─── SE-11: verifySignature compares in constant time ──────────────────────
// The expected value is recomputed exactly as release.ts signs it (the
// signing secret is the module default in the test env, as release.test
// already assumes).

describe('verifySignature (SE-11)', () => {
  const sign = (version: string, bundleHash: string) =>
    createHmac('sha256', 'dev-only-signing-secret').update(`${version}:${bundleHash}`).digest('hex');

  it('accepts the genuine HMAC for the version + bundle hash', () => {
    expect(verifySignature('1.0.0', 'abc123', sign('1.0.0', 'abc123'))).toBe(true);
  });

  it('rejects a tampered signature of the same length', () => {
    const good = sign('1.0.0', 'abc123');
    const tampered = (good.startsWith('0') ? '1' : '0') + good.slice(1);
    expect(tampered).toHaveLength(good.length);
    expect(verifySignature('1.0.0', 'abc123', tampered)).toBe(false);
  });

  it('rejects a signature computed for a different bundle', () => {
    expect(verifySignature('1.0.0', 'abc123', sign('1.0.0', 'other'))).toBe(false);
  });

  it('rejects truncated and empty signatures without throwing', () => {
    const good = sign('1.0.0', 'abc123');
    expect(verifySignature('1.0.0', 'abc123', good.slice(0, 32))).toBe(false);
    expect(verifySignature('1.0.0', 'abc123', '')).toBe(false);
  });
});
