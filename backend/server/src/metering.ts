// Usage metering (TE-04): invocation counts per project, aggregated per
// customer (tier), so invoices can be checked against what actually ran.
//
// The meter's source of truth is `telemetry_events`: the data plane writes
// exactly one row per invoke attempt in `invoke()`'s finish() — success,
// upstream error, policy block, and rate-limit alike. Metering is therefore
// a pure aggregation over that table: no second counter to drift, and any
// historical window can be re-metered from the rows themselves. (When
// TE-01 moves telemetry to Kinesis→S3→Athena, this aggregation moves with
// it; the shapes below are the contract the billing side consumes.)
//
// What counts: every recorded invoke counts toward the project's metered
// total, broken out `by_status` so billing can see exactly what the total
// is made of (ok / upstream_error / policy_blocked / rate_limited / …).
// Plans today are flat tiers (no per-invoke price), so the meter's job is
// reconciliation, not rating: `reconcileUsage` compares the metered
// per-project counts against the usage line items on a Stripe invoice
// (lines carrying `metadata.foundry_project_id` + `quantity`) and reports
// every discrepancy — a wrong invoice is a diff list, never a silent pass.
//
// Periods are half-open UTC calendar windows [start, end). The default is
// the current calendar month, matching the Stripe subscription cycle;
// explicit `from`/`to` (ISO dates) allow re-checking any past invoice.

import { one, q } from './db.js';

export interface UsagePeriod {
  start: Date;
  end: Date;
}

/** The UTC calendar month containing `now`, as a half-open window. */
export function currentMonthPeriod(now: Date = new Date()): UsagePeriod {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start, end };
}

/** Longest window a single usage query may span (a leap year + slack). */
export const MAX_USAGE_WINDOW_DAYS = 400;

export type PeriodParse =
  | { ok: true; period: UsagePeriod }
  | { ok: false; fields: Record<string, string> };

/**
 * Resolve `?from=` / `?to=` query params into a period. Each side defaults
 * independently to the current calendar month's bound, so `?from=` alone
 * means "from then until the end of this month". Invalid input is a 400
 * with field-level messages (BE-04 style), never a 500.
 */
export function parseUsagePeriod(
  query: { from?: unknown; to?: unknown },
  now: Date = new Date(),
): PeriodParse {
  const fallback = currentMonthPeriod(now);
  const fields: Record<string, string> = {};
  const parseSide = (raw: unknown, name: 'from' | 'to', dflt: Date): Date => {
    if (raw === undefined || raw === null || raw === '') return dflt;
    if (typeof raw !== 'string') {
      fields[name] = `${name} must be an ISO date string`;
      return dflt;
    }
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) {
      fields[name] = `${name} must be an ISO date string`;
      return dflt;
    }
    return d;
  };
  const start = parseSide(query.from, 'from', fallback.start);
  const end = parseSide(query.to, 'to', fallback.end);
  if (Object.keys(fields).length > 0) return { ok: false, fields };
  if (end.getTime() <= start.getTime()) {
    return { ok: false, fields: { to: 'to must be after from' } };
  }
  if (end.getTime() - start.getTime() > MAX_USAGE_WINDOW_DAYS * 86_400_000) {
    return { ok: false, fields: { to: `window must not exceed ${MAX_USAGE_WINDOW_DAYS} days` } };
  }
  return { ok: true, period: { start, end } };
}

export interface ProjectUsage {
  project_id: string;
  project_name: string | null;
  invocations: number;
  by_status: Record<string, number>;
}

export interface CustomerUsage {
  customer_id: string;
  plan_id: string;
  plan_name: string;
  period: { start: string; end: string };
  totals: { invocations: number; by_status: Record<string, number> };
  projects: ProjectUsage[];
}

interface UsageRow {
  project_id: string;
  project_name: string | null;
  status: string | null;
  n: number;
}

/**
 * Fold grouped (project, status) count rows into per-project usage plus
 * customer totals. Pure — the SQL below returns exactly this shape, and
 * tests drive it directly. Rows arrive sorted by project then status, so
 * `projects` order is stable; zero-usage projects (LEFT JOIN, status NULL)
 * appear with 0 invocations.
 */
export function foldUsageRows(rows: UsageRow[]): { projects: ProjectUsage[]; totals: CustomerUsage['totals'] } {
  const projects: ProjectUsage[] = [];
  const byProject = new Map<string, ProjectUsage>();
  const totals: CustomerUsage['totals'] = { invocations: 0, by_status: {} };
  for (const row of rows) {
    let p = byProject.get(row.project_id);
    if (!p) {
      p = { project_id: row.project_id, project_name: row.project_name, invocations: 0, by_status: {} };
      byProject.set(row.project_id, p);
      projects.push(p);
    }
    if (row.status == null) continue; // zero-usage project marker row
    const n = Number(row.n) || 0;
    p.invocations += n;
    p.by_status[row.status] = (p.by_status[row.status] ?? 0) + n;
    totals.invocations += n;
    totals.by_status[row.status] = (totals.by_status[row.status] ?? 0) + n;
  }
  return { projects, totals };
}

/**
 * Metered usage for one customer in a period: every project the customer
 * owns (zero-usage projects included) with invocation counts by status,
 * plus the tier-level totals. Returns null when the customer doesn't exist
 * (the route 404s); membership/role gating is the route's job.
 */
export async function customerUsage(customerId: string, period: UsagePeriod): Promise<CustomerUsage | null> {
  const customer = await one<any>(
    `SELECT c.id, c.plan_id, p.name AS plan_name
       FROM customers c JOIN plans p ON p.id = c.plan_id
      WHERE c.id = $1`,
    [customerId],
  );
  if (!customer) return null;
  const rows = await q<UsageRow>(
    `SELECT pr.id AS project_id, pr.name AS project_name, te.status AS status,
            COUNT(te.id)::int AS n
       FROM projects pr
       LEFT JOIN telemetry_events te
         ON te.project_id = pr.id AND te.created_at >= $2 AND te.created_at < $3
      WHERE pr.customer_id = $1
      GROUP BY pr.id, pr.name, te.status
      ORDER BY pr.name, pr.id, te.status`,
    [customerId, period.start.toISOString(), period.end.toISOString()],
  );
  const { projects, totals } = foldUsageRows(rows);
  return {
    customer_id: customer.id as string,
    plan_id: customer.plan_id as string,
    plan_name: customer.plan_name as string,
    period: { start: period.start.toISOString(), end: period.end.toISOString() },
    totals,
    projects,
  };
}

// ─── Reconciliation: metered usage vs. a Stripe invoice ────────────────────

export interface UsageLine {
  project_id: string;
  quantity: number;
}

export type DiscrepancyKind = 'quantity_mismatch' | 'missing_invoice_line' | 'unexpected_invoice_line';

export interface UsageDiscrepancy {
  project_id: string;
  kind: DiscrepancyKind;
  /** Metered invocations for the project (0 when the line names a project
   *  the meter has never seen). */
  metered: number;
  /** Invoiced quantity, or null when the invoice has no line for the project. */
  invoiced: number | null;
}

export interface UsageReconciliation {
  matched: boolean;
  metered_total: number;
  invoiced_total: number;
  discrepancies: UsageDiscrepancy[];
}

/**
 * Compare metered per-project counts against an invoice's usage lines.
 * Every difference is reported, in a stable order: metered-side problems
 * first (in metered order), then invoice-only lines (in invoice order).
 * A project metered at 0 needs no line; a line for it must say quantity 0.
 */
export function reconcileUsage(
  projects: { project_id: string; invocations: number }[],
  lines: UsageLine[],
): UsageReconciliation {
  const invoicedByProject = new Map<string, number>();
  for (const line of lines) {
    invoicedByProject.set(line.project_id, (invoicedByProject.get(line.project_id) ?? 0) + line.quantity);
  }
  const discrepancies: UsageDiscrepancy[] = [];
  const meteredProjects = new Set<string>();
  let meteredTotal = 0;
  for (const p of projects) {
    meteredProjects.add(p.project_id);
    meteredTotal += p.invocations;
    const invoiced = invoicedByProject.get(p.project_id);
    if (invoiced === undefined) {
      if (p.invocations > 0) {
        discrepancies.push({ project_id: p.project_id, kind: 'missing_invoice_line', metered: p.invocations, invoiced: null });
      }
    } else if (invoiced !== p.invocations) {
      discrepancies.push({ project_id: p.project_id, kind: 'quantity_mismatch', metered: p.invocations, invoiced });
    }
  }
  let invoicedTotal = 0;
  for (const [projectId, quantity] of invoicedByProject) {
    invoicedTotal += quantity;
    if (!meteredProjects.has(projectId)) {
      discrepancies.push({ project_id: projectId, kind: 'unexpected_invoice_line', metered: 0, invoiced: quantity });
    }
  }
  return { matched: discrepancies.length === 0, metered_total: meteredTotal, invoiced_total: invoicedTotal, discrepancies };
}

/**
 * Pull the usage lines off a Stripe invoice object: line items carrying
 * `metadata.foundry_project_id` and a numeric `quantity`. Flat plan-price
 * lines (no project metadata) are not usage and are ignored — reconciling
 * them is the plan-mapping check BL-01/BL-02 already own via webhooks.
 */
export function invoiceUsageLines(invoice: any): UsageLine[] {
  const data = invoice?.lines?.data;
  if (!Array.isArray(data)) return [];
  const lines: UsageLine[] = [];
  for (const line of data) {
    const projectId = line?.metadata?.foundry_project_id;
    if (typeof projectId === 'string' && projectId.length > 0 && typeof line?.quantity === 'number') {
      lines.push({ project_id: projectId, quantity: line.quantity });
    }
  }
  return lines;
}
