// EV-04: custom eval scenario CRUD routes.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../db.js', () => ({
  one: vi.fn(),
  q: vi.fn(),
  exec: vi.fn(),
  J: { parse: (v: any, fb: any) => (v == null ? fb : typeof v === 'string' ? JSON.parse(v) : v) },
  jb: (v: unknown) => JSON.stringify(v),
  uid: (() => { let n = 0; return () => `uid-${++n}`; })(),
  audit: vi.fn(),
}));
vi.mock('../auth.js', () => ({
  requireProjectRole: () => (_req: any, _res: any, next: any) => next(),
  requireProjectRead: () => (_req: any, _res: any, next: any) => next(),
}));

import { one, q, exec, audit } from '../db.js';
import { evalScenariosRouter } from './eval-scenarios.js';
import { errorHandler } from '../errors.js';

const oneMock = vi.mocked(one);
const qMock = vi.mocked(q);
const execMock = vi.mocked(exec);

function app() {
  const a = express();
  a.use(express.json());
  a.use((req: any, _res, next) => {
    req.auth = { userId: 'u1', memberships: [] };
    next();
  });
  a.use('/v1/projects', evalScenariosRouter);
  a.use(errorHandler);
  return a;
}

const anchor = { id: 'tool-1', project_id: 'p1' };
const stored = {
  id: 'scen-1', project_id: 'p1', tool_id: 'tool-1', name: 'Required args happy path',
  given_args: { latitude: 52.52 }, expect_status: 200,
  expect_body_keys: ['current'], enabled: true, created_by: 'u1',
};

beforeEach(() => {
  vi.clearAllMocks();
  oneMock.mockResolvedValue(anchor as any);
});

describe('POST /v1/projects/:id/tools/:toolId/eval-scenarios', () => {
  it('creates a scenario and audits it', async () => {
    oneMock
      .mockResolvedValueOnce(anchor as any) // anchor tool
      .mockResolvedValueOnce(undefined)     // name clash check
      .mockResolvedValueOnce(stored as any); // insert returning
    const res = await request(app())
      .post('/v1/projects/p1/tools/tool-1/eval-scenarios')
      .send({ name: 'Required args happy path', given_args: { latitude: 52.52 }, expect_status: 200, expect_body_keys: ['current'] });
    expect(res.status).toBe(201);
    expect(res.body.scenario).toMatchObject({ id: 'scen-1', name: 'Required args happy path', enabled: true });
    expect(vi.mocked(audit)).toHaveBeenCalledWith('p1', 'eval_scenario.created', 'eval_custom_scenario',
      expect.any(String), { tool_id: 'tool-1', name: 'Required args happy path' });
  });

  it('409s a duplicate name on the same tool', async () => {
    oneMock
      .mockResolvedValueOnce(anchor as any)
      .mockResolvedValueOnce({ id: 'scen-old' } as any);
    const res = await request(app())
      .post('/v1/projects/p1/tools/tool-1/eval-scenarios')
      .send({ name: 'Required args happy path' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('scenario_name_conflict');
  });

  it('400s a malformed body (bad status, empty name)', async () => {
    const bad = await request(app())
      .post('/v1/projects/p1/tools/tool-1/eval-scenarios')
      .send({ name: '', expect_status: 99 });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('invalid_request');
  });

  it('404s when the tool belongs to another project', async () => {
    oneMock.mockResolvedValue(undefined);
    const res = await request(app())
      .post('/v1/projects/p1/tools/tool-x/eval-scenarios')
      .send({ name: 'Anything' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('tool_not_found');
  });
});

describe('GET / PATCH / DELETE eval scenarios', () => {
  it('lists scenarios oldest-first', async () => {
    qMock.mockResolvedValue([stored] as any);
    const res = await request(app()).get('/v1/projects/p1/tools/tool-1/eval-scenarios');
    expect(res.status).toBe(200);
    expect(res.body.scenarios).toHaveLength(1);
    expect(res.body.scenarios[0].name).toBe('Required args happy path');
    expect(String(qMock.mock.calls[0][0])).toContain('ORDER BY created_at ASC, name ASC');
  });

  it('patches fields and 404s an unknown scenario', async () => {
    oneMock
      .mockResolvedValueOnce(anchor as any)
      .mockResolvedValueOnce(stored as any) // existing
      // no name change → no clash query
      .mockResolvedValueOnce({ ...stored, enabled: false } as any); // update returning
    const res = await request(app())
      .patch('/v1/projects/p1/tools/tool-1/eval-scenarios/scen-1')
      .send({ enabled: false });
    expect(res.status).toBe(200);
    expect(res.body.scenario.enabled).toBe(false);
  });

  it('deletes and 404s when nothing matched', async () => {
    execMock.mockResolvedValueOnce(1);
    const ok = await request(app()).delete('/v1/projects/p1/tools/tool-1/eval-scenarios/scen-1');
    expect(ok.status).toBe(200);
    execMock.mockResolvedValueOnce(0);
    const missing = await request(app()).delete('/v1/projects/p1/tools/tool-1/eval-scenarios/scen-x');
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('scenario_not_found');
  });
});
