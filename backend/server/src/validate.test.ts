// BE-04: every mutation validates its body with zod — malformed input gets a
// 400 with field-level messages, never a 500 or a confusing downstream error.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { z } from 'zod';

vi.mock('./db.js', () => ({
  one: vi.fn(),
  q: vi.fn(),
  exec: vi.fn(),
  withTx: vi.fn(),
  J: { parse: (v: any, fb: any) => (v == null ? fb : typeof v === 'string' ? JSON.parse(v) : v) },
  jb: (v: unknown) => JSON.stringify(v),
  uid: () => 'uid-1',
  audit: vi.fn(),
}));

import { one } from './db.js';
import { validateBody, projectCreateSchema } from './validate.js';
import { projectsRouter, toolsRouter } from './routes/tools.js';
import { sourcesRouter } from './routes/sources.js';
import { releasesRouter, runtimeRouter } from './routes/workflow.js';
import { membersRouter } from './routes/members.js';
import { adminRouter } from './routes/admin.js';
import { billingRouter } from './routes/billing.js';

const oneMock = vi.mocked(one);

const memberships = [
  { customerId: 'c1', customerName: 'Demo', customerStatus: 'active', planId: 'starter',
    planName: 'Starter', seatCap: 3, projectCap: 5, telemetryRetentionDays: 90,
    trialEndsAt: null, pastDueSince: null, role: 'owner', membershipStatus: 'active' },
];
const auth = { userId: 'u1', email: 'dev@x.test', fullName: 'Dev', isPlatformAdmin: false, memberships };

function app() {
  const a = express();
  a.use(express.json());
  a.use((req: any, _res, next) => { req.auth = auth; next(); });
  a.use('/v1/projects', projectsRouter);
  a.use('/v1/projects', toolsRouter);
  a.use('/v1/projects', sourcesRouter);
  a.use('/v1/projects', releasesRouter);
  a.use('/v1/runtime', runtimeRouter);
  a.use('/v1/customers', membersRouter);
  a.use('/v1/customers', billingRouter);
  a.use('/v1/admin', adminRouter);
  return a;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Every role check resolves the project to customer c1, where the caller is owner.
  oneMock.mockResolvedValue({ id: 'p1', customer_id: 'c1' });
});

function expectField400(res: any, field: string) {
  expect(res.status).toBe(400);
  expect(res.body.error).toBe('invalid_request');
  expect(typeof res.body.fields[field]).toBe('string');
}

describe('validateBody middleware', () => {
  it('passes valid bodies through untouched', async () => {
    const a = express();
    a.use(express.json());
    a.post('/x', validateBody(projectCreateSchema), (req, res) => res.json({ name: req.body.name }));
    const res = await request(a).post('/x').send({ name: 'Acme' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Acme');
  });

  it('400s a missing body with field-level messages', async () => {
    const a = express();
    a.use(express.json());
    a.post('/x', validateBody(projectCreateSchema), (_req, res) => res.json({ ok: true }));
    const res = await request(a).post('/x').send({});
    expectField400(res, 'name');
  });

  it('reports every bad field, not just the first', async () => {
    const schema = z.object({ a: z.string().min(1), b: z.string().min(1) });
    const a = express();
    a.use(express.json());
    a.post('/x', validateBody(schema), (_req, res) => res.json({ ok: true }));
    const res = await request(a).post('/x').send({});
    expect(res.status).toBe(400);
    expect(Object.keys(res.body.fields).sort()).toEqual(['a', 'b']);
  });

  it('400s a non-object body', async () => {
    const a = express();
    a.use(express.json());
    a.post('/x', validateBody(projectCreateSchema), (_req, res) => res.json({ ok: true }));
    const res = await request(a).post('/x').set('Content-Type', 'application/json').send('"just a string"');
    expect(res.status).toBe(400);
  });
});

describe('BE-04 route-level validation', () => {
  it('import: rejects an unknown source type', async () => {
    const res = await request(app()).post('/v1/projects/p1/sources').send({ type: 'carrier_pigeon', payload: 'x' });
    expectField400(res, 'type');
  });

  it('import: rejects a missing payload', async () => {
    const res = await request(app()).post('/v1/projects/p1/sources').send({ type: 'openapi_url' });
    expectField400(res, 'payload');
  });

  it('review item: rejects a bad status', async () => {
    const res = await request(app()).patch('/v1/projects/review/ri1').send({ status: 'maybe' });
    expectField400(res, 'status');
  });

  it('release: rejects a missing version', async () => {
    const res = await request(app()).post('/v1/projects/p1/releases').send({});
    expectField400(res, 'version');
  });

  it('invoke: rejects a missing tool_name', async () => {
    const res = await request(app()).post('/v1/runtime/invoke').send({ project_id: 'p1', version: '1' });
    expectField400(res, 'tool_name');
  });

  it('invoke: rejects non-object args', async () => {
    const res = await request(app())
      .post('/v1/runtime/invoke')
      .send({ project_id: 'p1', version: '1', tool_name: 't', args: [1, 2] });
    expectField400(res, 'args');
  });

  it('tool patch: rejects an unknown status', async () => {
    const res = await request(app()).patch('/v1/projects/tools/t1').send({ status: 'vibes' });
    expectField400(res, 'status');
  });

  it('invite: rejects a malformed email', async () => {
    const res = await request(app()).post('/v1/customers/c1/users/invite').send({ email: 'not-an-email' });
    expectField400(res, 'email');
  });

  it('member patch: rejects a bad role', async () => {
    const res = await request(app()).patch('/v1/customers/c1/users/u2').send({ role: 'superadmin' });
    expectField400(res, 'role');
  });

  it('admin: rejects creating a customer without a name', async () => {
    const res = await request(app()).post('/v1/admin/customers').send({});
    expectField400(res, 'name');
  });

  it('checkout: rejects a missing plan_id', async () => {
    const res = await request(app()).post('/v1/customers/c1/billing/checkout').send({});
    expectField400(res, 'plan_id');
  });
});
