// BE-05: the central error middleware never leaks internals and always
// answers in { error, code, request_id }.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

import { HttpError, asyncHandler, errorHandler, notFoundHandler } from './errors.js';

function fakeRes() {
  const headers: Record<string, string> = {};
  const res: any = {
    headersSent: false,
    setHeader: (k: string, v: string) => { headers[k.toLowerCase()] = v; },
    getHeader: (k: string) => headers[k.toLowerCase()],
    statusCode: 200,
    body: undefined as any,
    status(code: number) { res.statusCode = code; return res; },
    json(payload: any) { res.body = payload; return res; },
  };
  return res;
}
const req = (id?: string) => ({ id } as any);

describe('HttpError', () => {
  it('carries status, code, and a client-safe message', () => {
    const e = new HttpError(409, 'release_version_exists', 'Release version 1.0.0 already exists');
    expect(e.status).toBe(409);
    expect(e.code).toBe('release_version_exists');
    expect(e.message).toBe('Release version 1.0.0 already exists');
    expect(e).toBeInstanceOf(Error);
  });
});

describe('errorHandler', () => {
  it('maps HttpError to its status with { error, code, request_id }', () => {
    const res = fakeRes();
    errorHandler(new HttpError(404, 'release_not_found', 'Release not found'), req(), res, (() => {}) as any);
    expect(res.statusCode).toBe(404);
    expect(res.body.error).toBe('Release not found');
    expect(res.body.code).toBe('release_not_found');
    expect(typeof res.body.request_id).toBe('string');
    expect(res.getHeader('x-request-id')).toBe(res.body.request_id);
  });

  it('falls back to a default message when HttpError has no public message', () => {
    const res = fakeRes();
    errorHandler(new HttpError(400, 'release_blocked'), req(), res, (() => {}) as any);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('Bad request');
    expect(res.body.code).toBe('release_blocked');
  });

  it('prefers req.id (the BE-06 request id) when present', () => {
    const res = fakeRes();
    errorHandler(new Error('boom'), req('req-123'), res, (() => {}) as any);
    expect(res.body.request_id).toBe('req-123');
    expect(res.getHeader('x-request-id')).toBe('req-123');
  });

  it('keeps legacy { status } throw sites working (auth 401/403, billing 503)', () => {
    for (const [status, code] of [[401, 'unauthorized'], [403, 'forbidden'], [503, 'request_error']] as const) {
      const res = fakeRes();
      errorHandler(Object.assign(new Error('deliberate message'), { status }), req(), res, (() => {}) as any);
      expect(res.statusCode).toBe(status);
      expect(res.body.error).toBe('deliberate message');
      expect(res.body.code).toBe(code);
      expect(typeof res.body.request_id).toBe('string');
    }
  });

  it('turns an unknown error into a safe generic 500 with NO stack or internals', () => {
    const res = fakeRes();
    const pgish = Object.assign(new Error('relation "canonical_tools" does not exist'), {
      stack: 'Error: relation "canonical_tools" does not exist\n    at Connection.parseMessage (/app/node_modules/pg/lib/connection.js:119:33)',
    });
    errorHandler(pgish, req(), res, (() => {}) as any);
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({
      error: 'Internal server error',
      code: 'internal_error',
      request_id: expect.any(String),
    });
    expect(JSON.stringify(res.body)).not.toContain('canonical_tools');
    expect(JSON.stringify(res.body)).not.toContain('parseMessage');
  });
});

describe('asyncHandler', () => {
  it('forwards async rejections to next() (Express 4 does not do this itself)', async () => {
    const boom = new Error('db down');
    const next = vi.fn();
    const wrapped = asyncHandler(async () => { throw boom; });
    await (wrapped as any)({}, {}, next);
    // let the promise rejection propagate through the wrapper
    await new Promise((r) => setImmediate(r));
    expect(next).toHaveBeenCalledWith(boom);
  });

  it('does not call next() on success', async () => {
    const next = vi.fn();
    let ran = false;
    const wrapped = asyncHandler(async (_req: any, res: any) => { ran = true; res.json({ ok: true }); });
    const res = fakeRes();
    await (wrapped as any)({}, res, next);
    await new Promise((r) => setImmediate(r));
    expect(ran).toBe(true);
    expect(next).not.toHaveBeenCalled();
  });
});

describe('notFoundHandler', () => {
  it('returns a JSON 404 in the error envelope', () => {
    const res = fakeRes();
    notFoundHandler(req(), res);
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: 'Not found', code: 'not_found', request_id: expect.any(String) });
  });
});

// ─── End-to-end through a real router ─────────────────────────────────────────

vi.mock('./db.js', () => ({ one: vi.fn() }));
vi.mock('./queue.js', () => ({ enqueueJob: vi.fn(), getJob: vi.fn(), listJobs: vi.fn() }));
vi.mock('./release.js', () => ({
  createRelease: vi.fn(),
  approveRelease: vi.fn(),
  getManifest: vi.fn(),
}));

import { one } from './db.js';
import { enqueueJob } from './queue.js';
import { createRelease } from './release.js';
import { jobsRouter } from './routes/jobs.js';
import { releasesRouter } from './routes/workflow.js';

const oneMock = vi.mocked(one);
const enqueueMock = vi.mocked(enqueueJob);
const createReleaseMock = vi.mocked(createRelease);

const auth = {
  userId: 'u1',
  memberships: [{ customerId: 'c1', role: 'owner', customerStatus: 'active' }],
};

function app() {
  const a = express();
  a.use(express.json());
  a.use((req: any, _res, next) => { req.auth = auth; next(); });
  a.use('/v1/projects', jobsRouter);
  a.use('/v1/projects', releasesRouter);
  a.use(notFoundHandler);
  a.use(errorHandler);
  return a;
}

beforeEach(() => {
  vi.clearAllMocks();
  oneMock.mockResolvedValue({ id: 'p1', customer_id: 'c1' });
});

describe('BE-05 over HTTP', () => {
  it('a queue/DB failure becomes a safe 500 — no leaked internals', async () => {
    enqueueMock.mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:5432 — pool exhausted'));
    const res = await request(app()).post('/v1/projects/p1/compile');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Internal server error');
    expect(res.body.code).toBe('internal_error');
    expect(typeof res.body.request_id).toBe('string');
    expect(res.headers['x-request-id']).toBe(res.body.request_id);
    expect(res.text).not.toContain('ECONNREFUSED');
    expect(res.text).not.toContain('stack');
  });

  it('a release domain error keeps its status and code', async () => {
    createReleaseMock.mockRejectedValue(
      new HttpError(409, 'release_version_exists', 'Release version 1.0.0 already exists for this project'),
    );
    const res = await request(app()).post('/v1/projects/p1/releases').send({ version: '1.0.0' });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      error: 'Release version 1.0.0 already exists for this project',
      code: 'release_version_exists',
    });
    expect(typeof res.body.request_id).toBe('string');
  });

  it('unknown routes get a JSON 404 in the envelope', async () => {
    const res = await request(app()).get('/v1/nope');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('not_found');
    expect(typeof res.body.request_id).toBe('string');
  });
});
