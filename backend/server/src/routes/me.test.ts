// FE-07: POST /v1/me/organization — a signed-in user with no membership
// creates their organization on the trial plan and becomes its active owner
// (no sample project, D-87).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

let uidN = 0;
const txQuery = vi.fn(async () => ({}));
vi.mock('../db.js', () => ({
  one: vi.fn(),
  q: vi.fn(),
  exec: vi.fn(),
  withTx: vi.fn(async (fn: any) => fn({ query: txQuery })),
  uid: () => `uid-${++uidN}`,
  jb: (v: any) => v,
  audit: vi.fn(),
}));

import { one, withTx } from '../db.js';
import { errorHandler } from '../errors.js';
import { meRouter } from './me.js';

const oneMock = vi.mocked(one);
const withTxMock = vi.mocked(withTx);

const NO_MEMBERSHIP = { userId: 'u-1', email: 'new@acme.test', fullName: 'New User', isPlatformAdmin: false, memberships: [] };
const MEMBER = {
  ...NO_MEMBERSHIP,
  memberships: [{
    customerId: 'c-9', customerName: 'Existing Org', customerStatus: 'trialing', planId: 'trial',
    planName: 'Trial', seatCap: 3, projectCap: 2, telemetryRetentionDays: 30, trialEndsAt: null,
    pastDueSince: null, role: 'owner', membershipStatus: 'active',
  }],
};

function app(auth: any = NO_MEMBERSHIP) {
  const a = express();
  a.use(express.json());
  a.use((req: any, _res, next) => { req.auth = auth; next(); });
  a.use('/v1', meRouter);
  a.use(errorHandler);
  return a;
}

function mockHappyDb() {
  oneMock
    .mockResolvedValueOnce({ id: 'trial', is_trial: true, trial_duration_days: 14, status: 'active' }) // trial plan
    .mockResolvedValueOnce({ id: 'uid-1', name: 'Acme Org', plan_name: 'Trial', status: 'trialing' }) // summary row
    .mockResolvedValueOnce({ n: 1 }) // seats
    .mockResolvedValueOnce({ n: 0 }); // projects
}

beforeEach(() => {
  vi.clearAllMocks();
  uidN = 0;
  txQuery.mockClear();
  withTxMock.mockImplementation(async (fn: any) => fn({ query: txQuery }));
});

describe('POST /v1/me/organization (FE-07)', () => {
  it('creates the org on the trial plan and makes the caller its owner', async () => {
    mockHappyDb();
    const res = await request(app()).post('/v1/me/organization').send({ name: 'Acme Org' });
    expect(res.status).toBe(201);
    expect(res.body.customer).toMatchObject({ id: 'uid-1', name: 'Acme Org', status: 'trialing', seats_used: 1 });
    expect(res.body).not.toHaveProperty('demo_project');

    // Two inserts in one tx: the customer, then the owner membership for the caller.
    expect(txQuery).toHaveBeenCalledTimes(2);
    const [custSql, custVals] = txQuery.mock.calls[0] as any[];
    expect(custSql).toContain('INSERT INTO customers');
    expect(custVals[0]).toBe('uid-1');
    expect(custVals[1]).toBe('Acme Org');
    expect(custVals[2]).toBe('acme-org');
    expect(custVals[3]).toBe('trial');
    const [memberSql, memberVals] = txQuery.mock.calls[1] as any[];
    expect(memberSql).toContain('INSERT INTO customer_users');
    expect(memberSql).toContain("'owner', 'active'");
    expect(memberVals[1]).toBe('uid-1'); // customer id
    expect(memberVals[2]).toBe('u-1'); // the caller becomes the owner

  });

  it('409s a non-admin who already holds an active membership — no second trial', async () => {
    const res = await request(app(MEMBER)).post('/v1/me/organization').send({ name: 'Second Org' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('organization_already_exists');
    expect(res.body.customer_id).toBe('c-9');
    expect(withTxMock).not.toHaveBeenCalled();
  });

  it('lets a platform admin through the guard (operator flow stays usable)', async () => {
    mockHappyDb();
    const admin = { ...MEMBER, isPlatformAdmin: true };
    const res = await request(app(admin)).post('/v1/me/organization').send({ name: 'Acme Org' });
    expect(res.status).toBe(201);
  });

  it('a duplicate organization name surfaces as a 409 name conflict, not a 500', async () => {
    oneMock.mockResolvedValueOnce({ id: 'trial', is_trial: true, trial_duration_days: 14, status: 'active' });
    withTxMock.mockRejectedValue(new Error('duplicate key value violates unique constraint "customers_slug_key"'));
    const res = await request(app()).post('/v1/me/organization').send({ name: 'Acme Org' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('customer_name_conflict');
  });

  it('rejects an empty name with a field-level 400 before touching the DB', async () => {
    const res = await request(app()).post('/v1/me/organization').send({ name: '   ' });
    expect(res.status).toBe(400);
    expect(res.body.fields.name).toBeTruthy();
    expect(withTxMock).not.toHaveBeenCalled();
  });
});

describe('GET /v1/me (unchanged by FE-07)', () => {
  it('still maps memberships for the console workspace picker', async () => {
    const res = await request(app(MEMBER)).get('/v1/me');
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe('u-1');
    expect(res.body.memberships[0]).toMatchObject({ customer_id: 'c-9', role: 'owner', writable: true });
  });

  it('exposes the plan retention window per membership (FE-03)', async () => {
    const res = await request(app(MEMBER)).get('/v1/me');
    expect(res.status).toBe(200);
    expect(res.body.memberships[0]).toMatchObject({
      plan_id: 'trial',
      plan_name: 'Trial',
      project_cap: 2,
      telemetry_retention_days: 30,
    });
  });
});
