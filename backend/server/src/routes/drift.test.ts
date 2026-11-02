// TE-03: drift detection routes.
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
vi.mock('../drift.js', () => ({
  prodReleaseFor: vi.fn(),
}));
vi.mock('../queue.js', () => ({
  enqueueJob: vi.fn(),
}));

import { q } from '../db.js';
import { prodReleaseFor } from '../drift.js';
import { enqueueJob } from '../queue.js';
import { driftRouter } from './drift.js';
import { errorHandler } from '../errors.js';

const qMock = vi.mocked(q);
const prodReleaseForMock = vi.mocked(prodReleaseFor);
const enqueueJobMock = vi.mocked(enqueueJob);

function app() {
  const a = express();
  a.use(express.json());
  a.use((req: any, _res, next) => {
    req.auth = { userId: 'u1', memberships: [] };
    next();
  });
  a.use('/v1/projects', driftRouter);
  a.use(errorHandler);
  return a;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('POST /v1/projects/:id/drift/check', () => {
  it('409s when the project has no prod release', async () => {
    prodReleaseForMock.mockResolvedValue(null);
    const res = await request(app()).post('/v1/projects/p1/drift/check');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('drift_no_prod_release');
    expect(enqueueJobMock).not.toHaveBeenCalled();
  });

  it('202s and enqueues a drift job when a prod release exists', async () => {
    prodReleaseForMock.mockResolvedValue({ id: 'rel-1', version: '1.0.0' });
    enqueueJobMock.mockResolvedValue({ job: { id: 'job-1', kind: 'drift' }, deduplicated: false } as any);
    const res = await request(app()).post('/v1/projects/p1/drift/check');
    expect(res.status).toBe(202);
    expect(enqueueJobMock).toHaveBeenCalledWith('drift', 'p1', 'u1');
    expect(res.body.job.kind).toBe('drift');
  });
});

describe('GET /v1/projects/:id/drift/alerts', () => {
  it('lists alerts with the BE-08 pagination envelope', async () => {
    qMock.mockResolvedValue([
      { id: 'da-1', project_id: 'p1', tool_name: 'getForecast', status: 'open', evidence: { failed_scenarios: ['happy_path_2xx_json'] }, last_seen_at: '2026-10-05T04:00:00Z' },
    ]);
    const res = await request(app()).get('/v1/projects/p1/drift/alerts');
    expect(res.status).toBe(200);
    expect(res.body.alerts).toHaveLength(1);
    expect(res.body.alerts[0].evidence.failed_scenarios).toEqual(['happy_path_2xx_json']);
    expect(res.body.pagination).toMatchObject({ limit: 50, has_more: false });
  });

  it('400s on an invalid status filter', async () => {
    const res = await request(app()).get('/v1/projects/p1/drift/alerts?status=bogus');
    expect(res.status).toBe(400);
  });
});

describe('GET /v1/projects/:id/drift/checks', () => {
  it('lists recent checks with summaries', async () => {
    qMock.mockResolvedValue([
      { id: 'dc-1', project_id: 'p1', status: 'succeeded', trigger: 'schedule', summary: { tools_checked: 2, tools_passed: 2 }, started_at: '2026-10-05T04:00:00Z' },
    ]);
    const res = await request(app()).get('/v1/projects/p1/drift/checks');
    expect(res.status).toBe(200);
    expect(res.body.checks[0].summary.tools_passed).toBe(2);
    expect(res.body.pagination).toMatchObject({ limit: 50, has_more: false });
  });
});
