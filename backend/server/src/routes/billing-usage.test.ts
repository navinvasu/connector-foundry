import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../db.js', () => ({
  one: vi.fn(),
  q: vi.fn(),
  exec: vi.fn(),
  withTx: vi.fn(),
  J: {
    parse: (v: any, fb: any) =>
      v == null ? fb : typeof v === 'string' ? JSON.parse(v) : v,
  },
  jb: (v: unknown) => JSON.stringify(v),
  uid: () => 'uid-1',
  audit: vi.fn(),
}));

import { one, q } from '../db.js';
import { billingRouter } from './billing.js';
import { currentMonthPeriod } from '../metering.js';

const oneMock = vi.mocked(one);
const qMock = vi.mocked(q);

const memberships = [
  { customerId: 'c1', customerName: 'Demo', customerStatus: 'active', planId: 'growth',
    planName: 'Growth', seatCap: 10, projectCap: 25, telemetryRetentionDays: 180,
    trialEndsAt: null, pastDueSince: null, role: 'owner', membershipStatus: 'active' },
  { customerId: 'c2', customerName: 'ViewOnly', customerStatus: 'active', planId: 'starter',
    planName: 'Starter', seatCap: 3, projectCap: 5, telemetryRetentionDays: 90,
    trialEndsAt: null, pastDueSince: null, role: 'viewer', membershipStatus: 'active' },
];
const auth = { userId: 'u1', email: 'dev@x.test', fullName: 'Dev', isPlatformAdmin: false, memberships };

function app() {
  const a = express();
  a.use(express.json());
  a.use((req: any, _res, next) => { req.auth = auth; next(); });
  // Mounted exactly as index.ts mounts it after the TE-04 fix.
  a.use('/v1/customers', billingRouter);
  return a;
}

beforeEach(() => {
  vi.clearAllMocks();
  oneMock.mockResolvedValue(undefined);
  qMock.mockResolvedValue([]);
});

describe('GET /v1/customers/:id/billing/usage (TE-04)', () => {
  it('returns metered per-project counts + tier totals for the current month by default', async () => {
    oneMock.mockResolvedValue({ id: 'c1', plan_id: 'growth', plan_name: 'Growth' });
    qMock.mockResolvedValue([
      { project_id: 'p1', project_name: 'Acme', status: 'ok', n: 42 },
      { project_id: 'p1', project_name: 'Acme', status: 'rate_limited', n: 3 },
    ]);
    const res = await request(app()).get('/v1/customers/c1/billing/usage');
    expect(res.status).toBe(200);
    const period = currentMonthPeriod();
    expect(res.body.usage.period).toEqual({
      start: period.start.toISOString(), end: period.end.toISOString(),
    });
    expect(res.body.usage.totals).toEqual({ invocations: 45, by_status: { ok: 42, rate_limited: 3 } });
    expect(res.body.usage.projects[0].invocations).toBe(45);
    expect(res.body.usage.plan_id).toBe('growth');
  });

  it('honours an explicit from/to window', async () => {
    oneMock.mockResolvedValue({ id: 'c1', plan_id: 'growth', plan_name: 'Growth' });
    const res = await request(app()).get('/v1/customers/c1/billing/usage?from=2026-08-01&to=2026-09-01');
    expect(res.status).toBe(200);
    expect(res.body.usage.period).toEqual({ start: '2026-08-01T00:00:00.000Z', end: '2026-09-01T00:00:00.000Z' });
    expect(qMock.mock.calls[0]![1]).toEqual(['c1', '2026-08-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z']);
  });

  it('400s on a malformed window with field-level errors', async () => {
    const res = await request(app()).get('/v1/customers/c1/billing/usage?from=nope');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
    expect(res.body.fields.from).toMatch(/ISO date/);
    expect(oneMock).not.toHaveBeenCalled();
  });

  it('404s when the customer row is gone', async () => {
    oneMock.mockResolvedValue(undefined);
    const res = await request(app()).get('/v1/customers/c1/billing/usage');
    expect(res.status).toBe(404);
  });

  it('403s a non-member before any metering happens', async () => {
    const res = await request(app()).get('/v1/customers/c-other/billing/usage');
    expect(res.status).toBe(403);
    expect(oneMock).not.toHaveBeenCalled();
    expect(qMock).not.toHaveBeenCalled();
  });

  it('lets a viewer read usage (billing transparency is read-only)', async () => {
    oneMock.mockResolvedValue({ id: 'c2', plan_id: 'starter', plan_name: 'Starter' });
    qMock.mockResolvedValue([{ project_id: 'p9', project_name: 'Solo', status: 'ok', n: 1 }]);
    const res = await request(app()).get('/v1/customers/c2/billing/usage');
    expect(res.status).toBe(200);
    expect(res.body.usage.totals.invocations).toBe(1);
  });
});

describe('GET /v1/customers/:id/billing/usage/reconciliation (TE-04)', () => {
  it('400s without an invoice_id', async () => {
    const res = await request(app()).get('/v1/customers/c1/billing/usage/reconciliation');
    expect(res.status).toBe(400);
    expect(res.body.fields.invoice_id).toMatch(/required/);
  });

  it('503s when Stripe is not configured (no keys in this environment)', async () => {
    const res = await request(app()).get('/v1/customers/c1/billing/usage/reconciliation?invoice_id=in_123');
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/STRIPE_SECRET_KEY/);
  });
});
