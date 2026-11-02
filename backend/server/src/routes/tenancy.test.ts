// BE-09: tenant scoping on project reads. Before BE-09, several GET routes
// (tools, sources, operations, review, eval runs, releases, manifest,
// telemetry) were guarded only by requireAuth — any signed-in user could
// read any project by id. They now go through requireProjectRead with the
// REAL auth middleware: user A (member of customer c1) cannot read user
// B's project (owned by c-other) — every route answers the same 404 as an
// unknown project and never runs its data query.
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
    str: (v: any) => JSON.stringify(v ?? null),
  },
  jb: (v: unknown) => JSON.stringify(v),
  uid: () => 'uid-1',
  audit: vi.fn(),
}));
vi.mock('../openapi.js', () => ({
  parseOpenApi: vi.fn(), fetchSpec: vi.fn(), buildInventory: vi.fn(),
  docScore: vi.fn(), classifyEffect: vi.fn(),
}));
vi.mock('../eval.js', () => ({ getRun: vi.fn() }));
vi.mock('../release.js', () => ({
  createRelease: vi.fn(), approveRelease: vi.fn(), rollbackRelease: vi.fn(),
  getManifest: vi.fn(),
  CONNECTOR_TARGETS: ['mcp', 'openai', 'muse'],
  defaultTargets: () => ['mcp', 'openai', 'muse'],
  normalizeTargets: (t: any) => (Array.isArray(t) ? t : []),
}));
vi.mock('../runtime.js', () => ({ invoke: vi.fn(), telemetrySummary: vi.fn() }));

import { one, q } from '../db.js';
import { getRun } from '../eval.js';
import { getManifest } from '../release.js';
import { telemetrySummary } from '../runtime.js';
import { toolsRouter } from './tools.js';
import { sourcesRouter } from './sources.js';
import { evalRouter, releasesRouter, runtimeRouter } from './workflow.js';
import { errorHandler } from '../errors.js';

const oneMock = vi.mocked(one);
const qMock = vi.mocked(q);
const getRunMock = vi.mocked(getRun);
const getManifestMock = vi.mocked(getManifest);
const telemetryMock = vi.mocked(telemetrySummary);

/** The project every route resolves to; tests flip customer_id to c-other. */
let projectRow: any = { id: 'p1', customer_id: 'c1' };

const membership = (customerId: string, role = 'viewer') => ({
  customerId, customerName: 'X', customerStatus: 'active', planId: 'starter',
  planName: 'Starter', seatCap: 3, projectCap: 5, telemetryRetentionDays: 90,
  trialEndsAt: null, pastDueSince: null, role, membershipStatus: 'active',
});

type Caller = 'member' | 'outsider' | 'admin';
function app(caller: Caller) {
  const a = express();
  a.use(express.json());
  const auth =
    caller === 'admin'
      ? { userId: 'admin1', email: 'a@x.test', fullName: null, isPlatformAdmin: true, memberships: [] }
      : caller === 'member'
        ? { userId: 'u1', email: 'm@x.test', fullName: null, isPlatformAdmin: false, memberships: [membership('c1')] }
        : { userId: 'u2', email: 'o@x.test', fullName: null, isPlatformAdmin: false, memberships: [membership('c2', 'owner')] };
  a.use((req: any, _res, next) => { req.auth = auth; next(); });
  a.use('/v1/projects', toolsRouter);
  a.use('/v1/projects', sourcesRouter);
  a.use('/v1/projects', evalRouter);
  a.use('/v1/projects', releasesRouter);
  a.use('/v1/projects', runtimeRouter);
  a.use('/v1', evalRouter); // GET /eval/runs/:runId
  a.use('/v1/releases', releasesRouter); // GET /:releaseId/manifest
  a.use(errorHandler);
  return a;
}

beforeEach(() => {
  vi.clearAllMocks();
  projectRow = { id: 'p1', customer_id: 'c1' };
  oneMock.mockImplementation(async (sql: string) => {
    const s = String(sql);
    // Project resolvers: direct (projectParam), via releases, via eval_runs.
    if (s.includes('FROM projects WHERE id') || s.includes('JOIN projects')) return projectRow;
    return undefined;
  });
  qMock.mockResolvedValue([]);
  getRunMock.mockResolvedValue({
    run: { id: 'run1', project_id: 'p1', summary: null }, results: [],
  } as any);
  getManifestMock.mockResolvedValue({ version: '1.0.0', tools: [] } as any);
  telemetryMock.mockResolvedValue({ by_status: [], by_tool: [], recent: [] } as any);
});

const qCalledWith = (frag: string) =>
  qMock.mock.calls.some((c) => String(c[0]).includes(frag));

// Every project-scoped read route wired in this story: [label, path, the
// data access that must NOT happen for an outsider].
const READ_ROUTES: Array<[string, string, () => boolean]> = [
  ['tools', '/v1/projects/p1/tools', () => qCalledWith('FROM canonical_tools')],
  ['sources', '/v1/projects/p1/sources', () => qCalledWith('FROM api_sources')],
  ['operations', '/v1/projects/p1/operations', () => qCalledWith('FROM operations')],
  ['review items', '/v1/projects/p1/review', () => qCalledWith('FROM review_items')],
  ['eval runs', '/v1/projects/p1/eval/runs', () => qCalledWith('FROM eval_runs WHERE')],
  ['eval run by id', '/v1/eval/runs/run1', () => getRunMock.mock.calls.length > 0],
  ['releases', '/v1/projects/p1/releases', () => qCalledWith('FROM releases WHERE')],
  ['release manifest', '/v1/releases/rel1/manifest', () => getManifestMock.mock.calls.length > 0],
  ['telemetry', '/v1/projects/p1/telemetry', () => telemetryMock.mock.calls.length > 0],
];

describe('BE-09 tenant-scoped project reads', () => {
  it.each(READ_ROUTES)('a viewer member can read %s', async (_label, path) => {
    const res = await request(app('member')).get(path);
    expect(res.status).toBe(200);
  });

  it.each(READ_ROUTES)('an outsider gets 404 on %s and the data query never runs', async (_label, path, dataRan) => {
    projectRow = { id: 'p1', customer_id: 'c-other' };
    const res = await request(app('outsider')).get(path);
    expect(res.status).toBe(404);
    expect(dataRan()).toBe(false);
  });

  it.each(READ_ROUTES)('a platform admin can read %s without a membership', async (_label, path) => {
    projectRow = { id: 'p1', customer_id: 'c-other' };
    const res = await request(app('admin')).get(path);
    expect(res.status).toBe(200);
  });

  it('an unknown project 404s identically for a member', async () => {
    projectRow = undefined;
    const res = await request(app('member')).get('/v1/projects/nope/tools');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Project not found');
    expect(qCalledWith('FROM canonical_tools')).toBe(false);
  });

  it('a project with no owning customer is not readable by a signed-in outsider', async () => {
    projectRow = { id: 'p1', customer_id: null };
    const res = await request(app('outsider')).get('/v1/projects/p1/tools');
    expect(res.status).toBe(404);
  });

  it('the manifest 404 names the release, not the project, for outsiders', async () => {
    projectRow = { id: 'p1', customer_id: 'c-other' };
    const res = await request(app('outsider')).get('/v1/releases/rel1/manifest');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Release not found');
  });

  it('SE-11: the release list never selects the signature column', async () => {
    const res = await request(app('member')).get('/v1/projects/p1/releases');
    expect(res.status).toBe(200);
    expect(res.body.releases).toEqual([]);
    const listCall = qMock.mock.calls.find((c) => String(c[0]).includes('FROM releases WHERE'));
    expect(listCall).toBeTruthy();
    // F-10: the HMAC has no client use — it must not leave the server in
    // a reader-visible list payload (the signed manifest endpoint aside).
    expect(String(listCall![0])).not.toMatch(/\bsignature\b/);
  });
});
