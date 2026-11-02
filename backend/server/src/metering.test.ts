import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./db.js', () => ({
  one: vi.fn(),
  q: vi.fn(),
  exec: vi.fn(),
  uid: () => 'uid-1',
}));

import { one, q } from './db.js';
import {
  currentMonthPeriod, parseUsagePeriod, foldUsageRows, customerUsage,
  reconcileUsage, invoiceUsageLines, MAX_USAGE_WINDOW_DAYS,
} from './metering.js';

const oneMock = vi.mocked(one);
const qMock = vi.mocked(q);

beforeEach(() => {
  vi.clearAllMocks();
  oneMock.mockResolvedValue(undefined);
  qMock.mockResolvedValue([]);
});

describe('currentMonthPeriod', () => {
  it('spans the UTC calendar month containing now (half-open)', () => {
    const p = currentMonthPeriod(new Date('2026-09-30T21:58:00.000Z'));
    expect(p.start.toISOString()).toBe('2026-09-01T00:00:00.000Z');
    expect(p.end.toISOString()).toBe('2026-10-01T00:00:00.000Z');
  });

  it('rolls December into January of the next year', () => {
    const p = currentMonthPeriod(new Date('2026-12-15T00:00:00.000Z'));
    expect(p.start.toISOString()).toBe('2026-12-01T00:00:00.000Z');
    expect(p.end.toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });
});

describe('parseUsagePeriod', () => {
  const NOW = new Date('2026-09-15T12:00:00.000Z');

  it('defaults to the current calendar month', () => {
    const r = parseUsagePeriod({}, NOW);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.period.start.toISOString()).toBe('2026-09-01T00:00:00.000Z');
      expect(r.period.end.toISOString()).toBe('2026-10-01T00:00:00.000Z');
    }
  });

  it('accepts explicit ISO from/to', () => {
    const r = parseUsagePeriod({ from: '2026-08-01', to: '2026-09-01' }, NOW);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.period.start.toISOString()).toBe('2026-08-01T00:00:00.000Z');
      expect(r.period.end.toISOString()).toBe('2026-09-01T00:00:00.000Z');
    }
  });

  it('defaults each side independently (from alone runs to month end)', () => {
    const r = parseUsagePeriod({ from: '2026-09-10' }, NOW);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.period.end.toISOString()).toBe('2026-10-01T00:00:00.000Z');
  });

  it('400s on an unparseable date with a field-level message', () => {
    const r = parseUsagePeriod({ from: 'last tuesday' }, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.fields.from).toMatch(/ISO date/);
  });

  it('400s when to is not after from', () => {
    const r = parseUsagePeriod({ from: '2026-09-01', to: '2026-09-01' }, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.fields.to).toMatch(/after from/);
  });

  it(`400s on a window longer than ${MAX_USAGE_WINDOW_DAYS} days`, () => {
    const r = parseUsagePeriod({ from: '2025-01-01', to: '2026-09-01' }, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.fields.to).toMatch(/must not exceed/);
  });
});

describe('foldUsageRows', () => {
  it('groups status counts per project and sums customer totals', () => {
    const { projects, totals } = foldUsageRows([
      { project_id: 'p1', project_name: 'Acme', status: 'ok', n: 10 },
      { project_id: 'p1', project_name: 'Acme', status: 'upstream_error', n: 2 },
      { project_id: 'p2', project_name: 'Beta', status: 'ok', n: 3 },
    ]);
    expect(projects).toEqual([
      { project_id: 'p1', project_name: 'Acme', invocations: 12, by_status: { ok: 10, upstream_error: 2 } },
      { project_id: 'p2', project_name: 'Beta', invocations: 3, by_status: { ok: 3 } },
    ]);
    expect(totals).toEqual({ invocations: 15, by_status: { ok: 13, upstream_error: 2 } });
  });

  it('keeps zero-usage projects (LEFT JOIN status NULL) at 0', () => {
    const { projects, totals } = foldUsageRows([
      { project_id: 'p1', project_name: 'Idle', status: null, n: 0 },
    ]);
    expect(projects).toEqual([
      { project_id: 'p1', project_name: 'Idle', invocations: 0, by_status: {} },
    ]);
    expect(totals.invocations).toBe(0);
  });

  it('coerces string counts from pg into numbers', () => {
    const { totals } = foldUsageRows([
      { project_id: 'p1', project_name: 'Acme', status: 'ok', n: '7' as any },
    ]);
    expect(totals.invocations).toBe(7);
  });
});

describe('customerUsage', () => {
  const PERIOD = { start: new Date('2026-09-01T00:00:00.000Z'), end: new Date('2026-10-01T00:00:00.000Z') };

  it('returns null for an unknown customer (route 404s)', async () => {
    oneMock.mockResolvedValue(undefined);
    expect(await customerUsage('nope', PERIOD)).toBeNull();
    expect(qMock).not.toHaveBeenCalled();
  });

  it('aggregates telemetry per project for the customer + plan, windowed half-open', async () => {
    oneMock.mockResolvedValue({ id: 'c1', plan_id: 'growth', plan_name: 'Growth' });
    qMock.mockResolvedValue([
      { project_id: 'p1', project_name: 'Acme', status: 'ok', n: 42 },
      { project_id: 'p1', project_name: 'Acme', status: 'policy_blocked', n: 1 },
      { project_id: 'p2', project_name: 'Idle', status: null, n: 0 },
    ]);
    const usage = await customerUsage('c1', PERIOD);
    expect(usage).toMatchObject({
      customer_id: 'c1', plan_id: 'growth', plan_name: 'Growth',
      period: { start: '2026-09-01T00:00:00.000Z', end: '2026-10-01T00:00:00.000Z' },
      totals: { invocations: 43, by_status: { ok: 42, policy_blocked: 1 } },
    });
    expect(usage!.projects).toHaveLength(2);
    // The aggregation is scoped to the customer and the [start, end) window.
    const [sql, params] = qMock.mock.calls[0]!;
    expect(String(sql)).toContain('pr.customer_id = $1');
    expect(String(sql)).toContain('te.created_at >= $2 AND te.created_at < $3');
    expect(String(sql)).toContain('JOIN telemetry_events');
    expect(params).toEqual(['c1', '2026-09-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z']);
  });
});

describe('invoiceUsageLines', () => {
  it('extracts only lines carrying a foundry project id + numeric quantity', () => {
    const invoice = {
      lines: {
        data: [
          { metadata: { foundry_project_id: 'p1' }, quantity: 42 }, // usage line
          { metadata: {}, quantity: 1, description: 'Starter plan' }, // flat price line — not usage
          { metadata: { foundry_project_id: 'p2' }, quantity: 7 },
          { metadata: { foundry_project_id: 'p3' }, quantity: null }, // malformed — skipped
          { quantity: 5 }, // no metadata at all
        ],
      },
    };
    expect(invoiceUsageLines(invoice)).toEqual([
      { project_id: 'p1', quantity: 42 },
      { project_id: 'p2', quantity: 7 },
    ]);
  });

  it('returns [] for invoices without a lines payload', () => {
    expect(invoiceUsageLines({})).toEqual([]);
    expect(invoiceUsageLines(null)).toEqual([]);
  });
});

describe('reconcileUsage — TE-04 AC: invoice line items match metered usage', () => {
  const metered = [
    { project_id: 'p1', invocations: 42 },
    { project_id: 'p2', invocations: 7 },
    { project_id: 'p3', invocations: 0 },
  ];

  it('matches when every metered project is invoiced at exactly its count', () => {
    const invoice = {
      lines: {
        data: [
          { metadata: { foundry_project_id: 'p1' }, quantity: 42 },
          { metadata: { foundry_project_id: 'p2' }, quantity: 7 },
          { metadata: {}, quantity: 1, description: 'Growth plan' }, // flat line ignored
        ],
      },
    };
    const r = reconcileUsage(metered, invoiceUsageLines(invoice));
    expect(r).toEqual({ matched: true, metered_total: 49, invoiced_total: 49, discrepancies: [] });
  });

  it('flags a quantity mismatch with both numbers', () => {
    const r = reconcileUsage(metered, [
      { project_id: 'p1', quantity: 40 },
      { project_id: 'p2', quantity: 7 },
    ]);
    expect(r.matched).toBe(false);
    expect(r.discrepancies).toEqual([
      { project_id: 'p1', kind: 'quantity_mismatch', metered: 42, invoiced: 40 },
    ]);
    expect(r.metered_total).toBe(49);
    expect(r.invoiced_total).toBe(47);
  });

  it('flags a metered project with no invoice line as missing', () => {
    const r = reconcileUsage(metered, [{ project_id: 'p2', quantity: 7 }]);
    expect(r.discrepancies).toEqual([
      { project_id: 'p1', kind: 'missing_invoice_line', metered: 42, invoiced: null },
    ]);
  });

  it('flags an invoice line for a project the meter never saw', () => {
    const r = reconcileUsage(metered, [
      { project_id: 'p1', quantity: 42 },
      { project_id: 'p2', quantity: 7 },
      { project_id: 'p-ghost', quantity: 3 },
    ]);
    expect(r.discrepancies).toEqual([
      { project_id: 'p-ghost', kind: 'unexpected_invoice_line', metered: 0, invoiced: 3 },
    ]);
  });

  it('sums split lines for the same project before comparing', () => {
    const r = reconcileUsage(metered, [
      { project_id: 'p1', quantity: 40 },
      { project_id: 'p1', quantity: 2 },
      { project_id: 'p2', quantity: 7 },
    ]);
    expect(r.matched).toBe(true);
  });

  it('a zero-usage project needs no line, but a line for it must say 0', () => {
    expect(reconcileUsage(metered, [
      { project_id: 'p1', quantity: 42 },
      { project_id: 'p2', quantity: 7 },
      { project_id: 'p3', quantity: 0 },
    ]).matched).toBe(true);
    const r = reconcileUsage(metered, [
      { project_id: 'p1', quantity: 42 },
      { project_id: 'p2', quantity: 7 },
      { project_id: 'p3', quantity: 5 },
    ]);
    expect(r.discrepancies).toEqual([
      { project_id: 'p3', kind: 'quantity_mismatch', metered: 0, invoiced: 5 },
    ]);
  });
});
