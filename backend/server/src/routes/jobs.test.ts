import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../db.js', () => ({
  one: vi.fn(),
  q: vi.fn(),
}));
vi.mock('../queue.js', () => ({
  enqueueJob: vi.fn(),
  getJob: vi.fn(),
  listJobs: vi.fn(),
}));

import { one, q } from '../db.js';
import { enqueueJob, getJob, listJobs } from '../queue.js';
import { jobsRouter, jobRouter } from './jobs.js';

const oneMock = vi.mocked(one);
const qMock = vi.mocked(q);
const enqueueMock = vi.mocked(enqueueJob);
const getJobMock = vi.mocked(getJob);
const listJobsMock = vi.mocked(listJobs);

const auth = {
  userId: 'u1',
  memberships: [{ customerId: 'c1', role: 'owner', customerStatus: 'active' }],
};

function app() {
  const a = express();
  a.use(express.json());
  a.use((req: any, _res, next) => { req.auth = auth; next(); });
  a.use('/v1/projects', jobsRouter);
  a.use('/v1', jobRouter);
  return a;
}

const job = { id: 'job-1', project_id: 'p1', kind: 'compile', status: 'queued' };

beforeEach(() => {
  vi.clearAllMocks();
  oneMock.mockResolvedValue({ id: 'p1', customer_id: 'c1' });
});

describe('POST /v1/projects/:id/compile', () => {
  it('enqueues and returns 202', async () => {
    enqueueMock.mockResolvedValue({ job: job as any, deduplicated: false });
    const res = await request(app()).post('/v1/projects/p1/compile');
    expect(res.status).toBe(202);
    expect(res.body.job.id).toBe('job-1');
    expect(res.body.deduplicated).toBe(false);
    expect(enqueueMock).toHaveBeenCalledWith('compile', 'p1', 'u1');
  });

  it('lets a platform admin act on a project they are not a member of (BE-09 scopedProject bypass)', async () => {
    oneMock.mockResolvedValue({ id: 'p2', customer_id: 'c-other' });
    enqueueMock.mockResolvedValue({ job: { ...job, project_id: 'p2' } as any, deduplicated: false });
    const a = express();
    a.use(express.json());
    a.use((req: any, _res, next) => {
      req.auth = { userId: 'admin1', isPlatformAdmin: true, memberships: [] };
      next();
    });
    a.use('/v1/projects', jobsRouter);
    const res = await request(a).post('/v1/projects/p2/compile');
    expect(res.status).toBe(202);
    expect(enqueueMock).toHaveBeenCalledWith('compile', 'p2', 'admin1');
  });

  it('404s for an unknown project', async () => {
    oneMock.mockResolvedValue(undefined);
    const res = await request(app()).post('/v1/projects/nope/compile');
    expect(res.status).toBe(404);
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it('404s for a project outside the caller\u2019s customers', async () => {
    oneMock.mockResolvedValue({ id: 'p2', customer_id: 'c-other' });
    const res = await request(app()).post('/v1/projects/p2/compile');
    expect(res.status).toBe(404);
    expect(enqueueMock).not.toHaveBeenCalled();
  });
});

describe('POST /v1/projects/:id/eval', () => {
  it('enqueues an eval job with 202', async () => {
    enqueueMock.mockResolvedValue({ job: { ...job, kind: 'eval' } as any, deduplicated: true });
    const res = await request(app()).post('/v1/projects/p1/eval');
    expect(res.status).toBe(202);
    expect(res.body.deduplicated).toBe(true);
    expect(enqueueMock).toHaveBeenCalledWith('eval', 'p1', 'u1', undefined);
  });

  it('passes a validated tool scope through to the queue', async () => {
    enqueueMock.mockResolvedValue({ job: { ...job, kind: 'eval' } as any, deduplicated: false });
    const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
    qMock.mockResolvedValue([{ id: ids[0] }, { id: ids[1] }]);
    const res = await request(app()).post('/v1/projects/p1/eval').send({ tool_ids: ids });
    expect(res.status).toBe(202);
    expect(enqueueMock).toHaveBeenCalledWith('eval', 'p1', 'u1', { tool_ids: ids });
  });

  it('400s on candidate tools — eval runs on approved tools only', async () => {
    const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
    qMock.mockResolvedValue([
      { id: ids[0], name: 'GetQuote', status: 'approved' },
      { id: ids[1], name: 'GetBonds', status: 'candidate' },
    ]);
    const res = await request(app()).post('/v1/projects/p1/eval').send({ tool_ids: ids });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('eval_unapproved_tools');
    expect(res.body.message).toMatch(/GetBonds/);
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it('400s on tools from another project', async () => {
    qMock.mockResolvedValue([{ id: '11111111-1111-4111-8111-111111111111' }]);
    const res = await request(app()).post('/v1/projects/p1/eval')
      .send({ tool_ids: ['11111111-1111-4111-8111-111111111111', '33333333-3333-4333-8333-333333333333'] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('eval_unknown_tools');
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it('400s on non-UUID tool ids', async () => {
    const res = await request(app()).post('/v1/projects/p1/eval').send({ tool_ids: ['nope'] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_request');
    expect(enqueueMock).not.toHaveBeenCalled();
  });
});

describe('GET /v1/projects/:id/jobs', () => {
  it('lists recent jobs for the project (default limit 50)', async () => {
    listJobsMock.mockResolvedValue([job] as any);
    const res = await request(app()).get('/v1/projects/p1/jobs');
    expect(res.status).toBe(200);
    expect(res.body.jobs).toHaveLength(1);
    expect(res.body.pagination).toMatchObject({ limit: 50, has_more: false, next_cursor: null });
    expect(listJobsMock).toHaveBeenCalledWith('p1', 50, null);
  });

  it('clamps the limit parameter to 100', async () => {
    listJobsMock.mockResolvedValue([]);
    await request(app()).get('/v1/projects/p1/jobs?limit=999');
    expect(listJobsMock).toHaveBeenCalledWith('p1', 100, null);
  });

  it('passes a cursor through to listJobs', async () => {
    listJobsMock.mockResolvedValue([]);
    const cursor = Buffer.from(JSON.stringify({ t: '2026-09-28T00:00:00.000Z', i: 'job-9' })).toString('base64url');
    await request(app()).get(`/v1/projects/p1/jobs?cursor=${cursor}`);
    expect(listJobsMock).toHaveBeenCalledWith('p1', 50, { t: '2026-09-28T00:00:00.000Z', i: 'job-9' });
  });

  it('400s on an invalid limit', async () => {
    const res = await request(app()).get('/v1/projects/p1/jobs?limit=abc');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_pagination');
    expect(listJobsMock).not.toHaveBeenCalled();
  });

  it('400s on a malformed cursor', async () => {
    const res = await request(app()).get('/v1/projects/p1/jobs?cursor=!!!');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_pagination');
    expect(listJobsMock).not.toHaveBeenCalled();
  });
});

describe('GET /v1/jobs/:jobId', () => {
  it('returns the job when its project is in scope', async () => {
    getJobMock.mockResolvedValue(job as any);
    const res = await request(app()).get('/v1/jobs/job-1');
    expect(res.status).toBe(200);
    expect(res.body.job.id).toBe('job-1');
  });

  it('404s for an unknown job', async () => {
    getJobMock.mockResolvedValue(null);
    const res = await request(app()).get('/v1/jobs/nope');
    expect(res.status).toBe(404);
  });

  it('404s when the job\u2019s project is outside the caller\u2019s customers', async () => {
    getJobMock.mockResolvedValue({ ...job, project_id: 'p2' } as any);
    oneMock.mockResolvedValue({ id: 'p2', customer_id: 'c-other' });
    const res = await request(app()).get('/v1/jobs/job-1');
    expect(res.status).toBe(404);
  });
});
