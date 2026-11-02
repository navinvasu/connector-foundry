// Admin customer-create (no sample project, D-87) and the BL-05 seat override.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

let uidN = 0;
vi.mock('../db.js', () => ({
  one: vi.fn(),
  q: vi.fn(),
  exec: vi.fn(),
  withTx: vi.fn(async (fn: any) => fn({ query: vi.fn() })),
  uid: () => `uid-${++uidN}`,
  audit: vi.fn(),
}));

import { one, exec, audit } from '../db.js';
import { adminRouter } from './admin.js';

const oneMock = vi.mocked(one);

function app() {
  const a = express();
  a.use(express.json());
  a.use((req: any, _res, next) => {
    req.auth = { userId: 'admin-1', email: 'op@foundry.test', isPlatformAdmin: true, memberships: [] };
    next();
  });
  a.use('/v1/admin', adminRouter);
  return a;
}

beforeEach(() => {
  vi.clearAllMocks();
  uidN = 0;
  oneMock
    .mockResolvedValueOnce({ id: 'trial', is_trial: true, trial_duration_days: 14 }) // plan lookup
    .mockResolvedValueOnce({ id: 'uid-1', name: 'Acme', plan_name: 'Trial' }) // customerSummary row
    .mockResolvedValueOnce({ n: 1 }) // seats
    .mockResolvedValueOnce({ n: 1 }); // projects
});

describe('POST /v1/admin/customers', () => {
  it('creates the customer without a sample project (D-87)', async () => {
    const res = await request(app()).post('/v1/admin/customers').send({ name: 'Acme' });
    expect(res.status).toBe(201);
    expect(res.body.customer.id).toBe('uid-1');
    expect(res.body).not.toHaveProperty('demo_project');
  });
});

describe('PATCH /v1/admin/customers/:id/seats (BL-05 seat override)', () => {
  const execMock = vi.mocked(exec);
  const auditMock = vi.mocked(audit);

  function mockSeatsFlow(before: unknown) {
    oneMock.mockReset();
    oneMock
      .mockResolvedValueOnce(before) // before-check (override + plan cap)
      .mockResolvedValueOnce({ id: 'c1', name: 'Acme', plan_name: 'Trial' }) // customerSummary row
      .mockResolvedValueOnce({ n: 2 }) // seats count
      .mockResolvedValueOnce({ n: 1 }); // projects count
  }

  it('sets a total seat override and audit-logs actor + reason', async () => {
    mockSeatsFlow({ seat_override: null, seat_cap: 3 });
    const res = await request(app()).patch('/v1/admin/customers/c1/seats')
      .send({ seats: 15, reason: 'pilot program' });
    expect(res.status).toBe(200);
    const update = execMock.mock.calls.find((c) => String(c[0]).includes('seat_override = $1'));
    expect(update).toBeDefined();
    expect(update![1]).toEqual([15, 'pilot program', 'op@foundry.test', 'c1']);
    expect(auditMock).toHaveBeenCalledWith(null, 'customer.seats_adjusted', 'customer', 'c1',
      expect.objectContaining({ seat_override: 15, from_effective: 3, to_effective: 15, actor: 'op@foundry.test' }));
  });

  it('clears the override with seats: null (back to the plan cap)', async () => {
    mockSeatsFlow({ seat_override: 15, seat_cap: 3 });
    const res = await request(app()).patch('/v1/admin/customers/c1/seats').send({ seats: null });
    expect(res.status).toBe(200);
    const update = execMock.mock.calls.find((c) => String(c[0]).includes('seat_override = $1'));
    expect(update![1]![0]).toBeNull();
    expect(auditMock).toHaveBeenCalledWith(null, 'customer.seats_adjusted', 'customer', 'c1',
      expect.objectContaining({ seat_override: null, to_effective: 3 }));
  });

  it('404s for an unknown customer and 400s for seats < 1', async () => {
    oneMock.mockReset();
    oneMock.mockResolvedValueOnce(undefined);
    const missing = await request(app()).patch('/v1/admin/customers/nope/seats').send({ seats: 5 });
    expect(missing.status).toBe(404);
    const bad = await request(app()).patch('/v1/admin/customers/c1/seats').send({ seats: 0 });
    expect(bad.status).toBe(400);
  });
});
