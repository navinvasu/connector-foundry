// BE-08: pagination on eval runs, releases, and telemetry endpoints.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../db.js', () => ({
  q: vi.fn(),
  J: { parse: (v: any, fb: any) => (v == null ? fb : typeof v === 'string' ? JSON.parse(v) : v) },
}));
vi.mock('../eval.js', () => ({ getRun: vi.fn() }));
vi.mock('../release.js', () => ({
  createRelease: vi.fn(),
  approveRelease: vi.fn(),
  getManifest: vi.fn(),
  rollbackRelease: vi.fn(),
}));
vi.mock('../runtime.js', () => ({
  invoke: vi.fn(),
  telemetrySummary: vi.fn(),
}));
vi.mock('../auth.js', () => ({
  // DP-07: the invoke dispatcher runs requireAuth for the human path;
  // tests inject req.auth upstream, so it passes through.
  requireAuth: (_req: any, _res: any, next: any) => next(),
  requireProjectRole: () => (_req: any, _res: any, next: any) => next(),
  // BE-09 scoping itself is covered in tenancy.test.ts with the real middleware.
  requireProjectRead: () => (_req: any, _res: any, next: any) => next(),
}));

import { q } from '../db.js';
import { invoke, telemetrySummary } from '../runtime.js';
import { resetInvokeRateLimiter } from '../rate-limit.js';
import { evalRouter, releasesRouter, runtimeRouter } from './workflow.js';

const qMock = vi.mocked(q);
const telemetryMock = vi.mocked(telemetrySummary);
const invokeMock = vi.mocked(invoke);

function app() {
  const a = express();
  a.use(express.json());
  a.use((req: any, _res, next) => { req.auth = { userId: 'u1', memberships: [] }; next(); });
  a.use('/v1/projects', evalRouter);
  a.use('/v1/projects', releasesRouter);
  a.use('/v1/projects', runtimeRouter);
  a.use('/v1/runtime', runtimeRouter); // POST /invoke
  a.use('/v1/releases', releasesRouter); // POST /:releaseId/approve, /:releaseId/rollback, /:releaseId/manifest
  return a;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetInvokeRateLimiter();
  qMock.mockResolvedValue([]);
});

describe('GET /v1/projects/:id/eval/runs', () => {
  it('pages eval runs newest-first with stable (started_at, id) ordering', async () => {
    qMock.mockResolvedValue([
      { id: 'r1', started_at: new Date('2026-09-28T10:00:00.000Z'), summary: '{"passed":true}' },
      { id: 'r2', started_at: new Date('2026-09-27T10:00:00.000Z'), summary: null },
    ]);
    const res = await request(app()).get('/v1/projects/p1/eval/runs?limit=10');
    expect(res.status).toBe(200);
    expect(res.body.runs).toHaveLength(2);
    expect(res.body.runs[0].summary).toEqual({ passed: true });
    expect(res.body.pagination).toMatchObject({ limit: 10, has_more: false, next_cursor: null });
    const [sql, params] = qMock.mock.calls[0]!;
    expect(String(sql)).toContain('ORDER BY started_at DESC, id DESC');
    expect(params![params!.length - 1]).toBe(11); // limit + 1 probe
  });

  it('returns next_cursor when a following page exists', async () => {
    qMock.mockResolvedValue([
      { id: 'r1', started_at: new Date('2026-09-28T10:00:00.000Z'), summary: null },
      { id: 'r2', started_at: new Date('2026-09-27T10:00:00.000Z'), summary: null },
    ]);
    const res = await request(app()).get('/v1/projects/p1/eval/runs?limit=1');
    expect(res.body.runs).toHaveLength(1);
    expect(res.body.runs[0].id).toBe('r1');
    expect(res.body.pagination.has_more).toBe(true);
    expect(typeof res.body.pagination.next_cursor).toBe('string');
  });

  it('applies a cursor filter on the next page', async () => {
    const cursor = Buffer.from(
      JSON.stringify({ t: '2026-09-28T10:00:00.000Z', i: 'r1' })).toString('base64url');
    qMock.mockResolvedValue([]);
    const res = await request(app()).get(`/v1/projects/p1/eval/runs?cursor=${cursor}`);
    expect(res.status).toBe(200);
    const [sql, params] = qMock.mock.calls[0]!;
    expect(String(sql)).toContain('(started_at, id) < ($2, $3)');
    expect(params).toEqual(['p1', '2026-09-28T10:00:00.000Z', 'r1', 51]);
  });

  it('400s on an invalid limit', async () => {
    const res = await request(app()).get('/v1/projects/p1/eval/runs?limit=0');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_pagination');
  });
});

describe('GET /v1/projects/:id/releases', () => {
  it('paginates releases with next_cursor metadata', async () => {
    qMock.mockResolvedValue([
      { id: 'rel1', version: 'v2', created_at: new Date('2026-09-28T00:00:00.000Z') },
      { id: 'rel2', version: 'v1', created_at: new Date('2026-09-27T00:00:00.000Z') },
    ]);
    const res = await request(app()).get('/v1/projects/p1/releases?limit=1');
    expect(res.status).toBe(200);
    expect(res.body.releases).toHaveLength(1);
    expect(res.body.releases[0].version).toBe('v2');
    expect(res.body.pagination).toMatchObject({ limit: 1, has_more: true });
    expect(typeof res.body.pagination.next_cursor).toBe('string');
  });

  it('400s on a malformed cursor', async () => {
    const res = await request(app()).get('/v1/projects/p1/releases?cursor=oops');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_pagination');
  });
});

// RL-06: rollback endpoint.
describe('POST /v1/releases/:releaseId/rollback', () => {
  it('deprecates and returns the fallback target', async () => {
    const { rollbackRelease } = await import('../release.js');
    vi.mocked(rollbackRelease).mockResolvedValue({
      release_id: 'r2', version: '2.0.0', deprecated: true,
      fallback: { release_id: 'r1', version: '1.0.0' },
    } as any);
    const res = await request(app()).post('/v1/releases/r2/rollback').send({ reason: 'bad schema' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      release_id: 'r2', version: '2.0.0', deprecated: true,
      fallback: { release_id: 'r1', version: '1.0.0' },
    });
    expect(vi.mocked(rollbackRelease)).toHaveBeenCalledWith('r2', expect.any(String), 'bad schema');
  });

  it('400s when reason is not a string', async () => {
    const res = await request(app()).post('/v1/releases/r2/rollback').send({ reason: 123 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_request');
  });
});

describe('GET /v1/projects/:id/telemetry', () => {
  it('passes pagination through to telemetrySummary', async () => {
    telemetryMock.mockResolvedValue({
      by_status: [], by_tool: [], recent: [],
      pagination: { limit: 25, has_more: false, next_cursor: null },
      retention: { retention_days: null, requested_hours: 336, effective_hours: 336, locked: false },
    } as any);
    const res = await request(app()).get('/v1/projects/p1/telemetry?limit=25');
    expect(res.status).toBe(200);
    // No plan row (mocked q returns []) → retentionDays null, default 14 days.
    expect(telemetryMock).toHaveBeenCalledWith('p1', 336, { limit: 25, cursor: null }, null);
    expect(res.body.pagination).toMatchObject({ limit: 25, has_more: false });
  });

  it('TE-02: a month-4 Starter query is clamped, not an error (locked state)', async () => {
    qMock.mockResolvedValueOnce([{ days: 90 }]);
    telemetryMock.mockResolvedValue({
      by_status: [], by_tool: [], recent: [],
      pagination: { limit: 50, has_more: false, next_cursor: null },
      retention: { retention_days: 90, requested_hours: 2880, effective_hours: 2160, locked: true },
    } as any);
    const res = await request(app()).get('/v1/projects/p1/telemetry?days=120');
    expect(res.status).toBe(200);
    expect(telemetryMock).toHaveBeenCalledWith('p1', 2880, { limit: 50, cursor: null }, 90);
    expect(res.body.retention).toMatchObject({ retention_days: 90, locked: true });
  });

  it('TE-02: 400s on a non-positive days window', async () => {
    for (const bad of ['0', '-3', 'abc']) {
      const res = await request(app()).get(`/v1/projects/p1/telemetry?days=${bad}`);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('invalid_request');
      expect(res.body.fields.days).toBeTruthy();
    }
    expect(telemetryMock).not.toHaveBeenCalled();
  });
});

// BE-07/SE-09: rate limiting on POST /v1/runtime/invoke (route level;
// IP bucket pre-auth, project bucket after the mocked role gate).
describe('POST /v1/runtime/invoke rate limiting (BE-07/SE-09)', () => {
  const body = { project_id: 'p1', version: '1.0.0', tool_name: 'getThing', args: {} };
  let savedProject: string | undefined;
  let savedIp: string | undefined;

  beforeEach(() => {
    savedProject = process.env.CF_INVOKE_RATE_LIMIT_PER_PROJECT;
    savedIp = process.env.CF_INVOKE_RATE_LIMIT_PER_IP;
    invokeMock.mockResolvedValue({ ok: true, tool: 'getThing', release_version: '1.0.0', result: {}, latency_ms: 3 } as any);
  });

  afterEach(() => {
    if (savedProject === undefined) delete process.env.CF_INVOKE_RATE_LIMIT_PER_PROJECT;
    else process.env.CF_INVOKE_RATE_LIMIT_PER_PROJECT = savedProject;
    if (savedIp === undefined) delete process.env.CF_INVOKE_RATE_LIMIT_PER_IP;
    else process.env.CF_INVOKE_RATE_LIMIT_PER_IP = savedIp;
  });

  it('admits under the limit, sets X-RateLimit headers, and marks the invoke pre-checked', async () => {
    process.env.CF_INVOKE_RATE_LIMIT_PER_PROJECT = '10';
    const res = await request(app()).post('/v1/runtime/invoke').send(body);
    expect(res.status).toBe(200);
    expect(res.headers['x-ratelimit-limit']).toBe('10');
    expect(invokeMock).toHaveBeenCalledWith(expect.objectContaining({
      project_id: 'p1', rate_limit_checked: true, client_ip: expect.any(String),
    }));
  });

  it('abusive client gets a 429 before invoke() runs; other projects unaffected', async () => {
    process.env.CF_INVOKE_RATE_LIMIT_PER_PROJECT = '2';
    process.env.CF_INVOKE_RATE_LIMIT_PER_IP = '100';
    const a = app();
    expect((await request(a).post('/v1/runtime/invoke').send(body)).status).toBe(200);
    expect((await request(a).post('/v1/runtime/invoke').send(body)).status).toBe(200);
    const denied = await request(a).post('/v1/runtime/invoke').send(body);
    expect(denied.status).toBe(429);
    expect(denied.body.code).toBe('rate_limited');
    expect(denied.body.rate_limit.bucket).toBe('project');
    expect(Number(denied.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(invokeMock).toHaveBeenCalledTimes(2); // the 429 never reached the data plane
    const other = await request(a).post('/v1/runtime/invoke').send({ ...body, project_id: 'p2' });
    expect(other.status).toBe(200);
  });

  it("maps invoke()'s RATE_LIMITED condition to HTTP 429 (not 502)", async () => {
    process.env.CF_INVOKE_RATE_LIMIT_PER_PROJECT = '10';
    invokeMock.mockResolvedValue({
      ok: false, tool: 'getThing', release_version: '1.0.0', latency_ms: 1,
      error: { condition: 'RATE_LIMITED', message: 'Rate limit exceeded' },
    } as any);
    const res = await request(app()).post('/v1/runtime/invoke').send({ ...body, project_id: 'p9' });
    expect(res.status).toBe(429);
    expect(res.body.error.condition).toBe('RATE_LIMITED');
  });
});
