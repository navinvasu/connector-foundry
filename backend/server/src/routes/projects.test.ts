import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

let uidN = 0;
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
  uid: () => `uid-${++uidN}`,
  audit: vi.fn(),
}));

import { one, q, exec, withTx, audit } from '../db.js';
import { projectsRouter, toolsRouter } from './tools.js';
import { meRouter } from './me.js';

const oneMock = vi.mocked(one);
const qMock = vi.mocked(q);
const execMock = vi.mocked(exec);
const withTxMock = vi.mocked(withTx);
const auditMock = vi.mocked(audit);

const memberships = [
  { customerId: 'c1', customerName: 'Demo', customerStatus: 'active', planId: 'starter',
    planName: 'Starter', seatCap: 3, projectCap: 5, telemetryRetentionDays: 90,
    trialEndsAt: null, pastDueSince: null, role: 'owner', membershipStatus: 'active' },
  { customerId: 'c2', customerName: 'Other', customerStatus: 'trial_expired', planId: 'trial',
    planName: 'Trial', seatCap: 3, projectCap: 2, telemetryRetentionDays: 30,
    trialEndsAt: null, pastDueSince: null, role: 'viewer', membershipStatus: 'active' },
];
const auth = { userId: 'u1', email: 'dev@x.test', fullName: 'Dev', isPlatformAdmin: false, memberships };

function app() {
  const a = express();
  a.use(express.json());
  a.use((req: any, _res, next) => { req.auth = auth; next(); });
  a.use('/v1/projects', projectsRouter);
  a.use('/v1/projects', toolsRouter);
  a.use('/v1', meRouter);
  return a;
}

beforeEach(() => {
  vi.clearAllMocks();
  uidN = 0;
  oneMock.mockResolvedValue(undefined);
  qMock.mockResolvedValue([]);
  execMock.mockResolvedValue(1);
});

describe('POST /v1/projects', () => {
  it('400s when name is missing', async () => {
    const res = await request(app()).post('/v1/projects').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
    expect(res.body.fields.name).toMatch(/name is required/);
  });

  it('400s when no known target is selected', async () => {
    const res = await request(app()).post('/v1/projects').send({ name: 'X', targets: ['bogus'] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Select at least one target/);
  });

  it('creates a project in the caller\u2019s first writable customer', async () => {
    oneMock
      .mockResolvedValueOnce({ n: 0 }) // project count for cap check
      .mockResolvedValueOnce({ id: 'uid-1', name: 'Acme', customer_id: 'c1' }); // final select
    const res = await request(app()).post('/v1/projects').send({ name: 'Acme', description: 'billing' });
    expect(res.status).toBe(201);
    expect(res.body.project.customer_id).toBe('c1');
    const insert = execMock.mock.calls.find((c) => String(c[0]).includes('INSERT INTO projects'))!;
    expect(insert[1]![1]).toBe('Acme'); // name
    expect(insert[1]![5]).toBe('u1'); // owner_user_id
    expect(auditMock).toHaveBeenCalledWith('uid-1', 'project.created', 'project', 'uid-1', expect.anything());
  });

  it('409s when the plan project cap is reached', async () => {
    oneMock.mockResolvedValueOnce({ n: 5 });
    const res = await request(app()).post('/v1/projects').send({ name: 'Acme' });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/Project limit reached/);
    // FE-03: machine-readable code + cap context so the console can render
    // the designed blocked state instead of a raw error.
    expect(res.body.code).toBe('project_limit_reached');
    expect(res.body).toMatchObject({ plan_name: 'Starter', projects_used: 5, project_cap: 5 });
  });

  it('counts every active project toward the cap (D-87: no cap-exempt sample project)', async () => {
    oneMock
      .mockResolvedValueOnce({ n: 0 }) // project count for cap check
      .mockResolvedValueOnce({ id: 'uid-1', name: 'Acme', customer_id: 'c1' }); // final select
    const res = await request(app()).post('/v1/projects').send({ name: 'Acme' });
    expect(res.status).toBe(201);
    const countCall = oneMock.mock.calls.find((c) => String(c[0]).includes('COUNT(*)'));
    expect(countCall).toBeDefined();
    expect(String(countCall![0])).not.toContain('is_demo');
  });

  it('409s organization_required when the caller has no writable organization', async () => {
    const a = express();
    a.use(express.json());
    a.use((req: any, _res, next) => { req.auth = { ...auth, memberships: [] }; next(); });
    a.use('/v1/projects', projectsRouter);
    const res = await request(a).post('/v1/projects').send({ name: 'Orders API' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('organization_required');
    expect(execMock).not.toHaveBeenCalled();
  });

  it('403s when customer_id is outside the caller\u2019s writable memberships', async () => {
    const res = await request(app()).post('/v1/projects').send({ name: 'Acme', customer_id: 'c2' });
    expect(res.status).toBe(403);
  });
});

describe('GET /v1/projects (BE-08 pagination)', () => {
  const projectRows = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: `p${i}`, name: `Project ${i}`,
      created_at: new Date(Date.UTC(2026, 8, 28 - (i % 20), 12, 0, 0)),
    }));

  it('returns page metadata and next_cursor when more rows exist', async () => {
    qMock.mockResolvedValue(projectRows(51));
    const res = await request(app()).get('/v1/projects?limit=50');
    expect(res.status).toBe(200);
    expect(res.body.projects).toHaveLength(50);
    expect(res.body.pagination).toMatchObject({ limit: 50, has_more: true });
    expect(typeof res.body.pagination.next_cursor).toBe('string');
    const [sql, params] = qMock.mock.calls[0]!;
    expect(String(sql)).toContain('ORDER BY p.created_at DESC, p.id DESC');
    expect(params![params!.length - 1]).toBe(51); // limit + 1 probe
  });

  it('returns a null cursor on the last page', async () => {
    qMock.mockResolvedValue(projectRows(3));
    const res = await request(app()).get('/v1/projects');
    expect(res.status).toBe(200);
    expect(res.body.projects).toHaveLength(3);
    expect(res.body.pagination).toMatchObject({ limit: 50, has_more: false, next_cursor: null });
  });

  it('400s on an invalid limit without touching the database', async () => {
    const res = await request(app()).get('/v1/projects?limit=-1');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_pagination');
    expect(res.body.fields.limit).toMatch(/positive integer/);
    expect(qMock).not.toHaveBeenCalled();
  });

  it('400s on a malformed cursor', async () => {
    const res = await request(app()).get('/v1/projects?cursor=not-a-cursor');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_pagination');
    expect(qMock).not.toHaveBeenCalled();
  });
});

describe('GET /v1/projects/:id', () => {
  it('404s when the project is not visible to the caller', async () => {
    oneMock.mockResolvedValue(undefined);
    const res = await request(app()).get('/v1/projects/nope');
    expect(res.status).toBe(404);
  });

  it('returns the enriched project row', async () => {
    oneMock.mockResolvedValue({ id: 'p1', name: 'Acme', operations_count: 3 });
    const res = await request(app()).get('/v1/projects/p1');
    expect(res.status).toBe(200);
    expect(res.body.project.operations_count).toBe(3);
    expect(oneMock.mock.calls[0]![1]![0]).toBe('p1');
    expect(oneMock.mock.calls[0]![1]![1]).toEqual(['c1', 'c2']);
  });
});

describe('PATCH /v1/projects/:id', () => {
  it('400s on an empty name', async () => {
    oneMock.mockResolvedValue({ id: 'p1', customer_id: 'c1' });
    const res = await request(app()).patch('/v1/projects/p1').send({ name: '  ' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
    expect(res.body.fields.name).toMatch(/must not be empty/);
  });

  it('404s when nothing was updated', async () => {
    oneMock.mockResolvedValue({ id: 'p1', customer_id: 'c1' });
    execMock.mockResolvedValue(0);
    const res = await request(app()).patch('/v1/projects/p1').send({ name: 'New' });
    expect(res.status).toBe(404);
  });
});

describe('GET /v1/projects/:id/tools', () => {
  it('parses JSONB columns and attaches recovery rules', async () => {
    oneMock.mockResolvedValue({ id: 'p1', customer_id: 'c1' }); // BE-09 read-scope resolver
    qMock
      .mockResolvedValueOnce([{ id: 't1', version: 1, name: 'getInvoices', input_schema: '{"type":"object"}', upstream: '{}', effect_classes: '["read_only"]', required_scopes: '[]', provenance: '[]' }])
      .mockResolvedValueOnce([{ condition: 'RATE_LIMITED' }]);
    const res = await request(app()).get('/v1/projects/p1/tools');
    expect(res.status).toBe(200);
    expect(res.body.tools[0].input_schema).toEqual({ type: 'object' });
    expect(res.body.tools[0].recovery_rules).toEqual([{ condition: 'RATE_LIMITED' }]);
  });
});

describe('GET /v1/projects/:id/tools (BE-08 pagination)', () => {
  it('paginates the alphabetical tool list with keyset ordering', async () => {
    oneMock.mockResolvedValue({ id: 'p1', customer_id: 'c1' }); // BE-09 read-scope resolver
    const rows = [
      { id: 't1', version: 1, name: 'aTool', input_schema: '{}', upstream: '{}', effect_classes: '[]', required_scopes: '[]', provenance: '[]' },
      { id: 't2', version: 1, name: 'bTool', input_schema: '{}', upstream: '{}', effect_classes: '[]', required_scopes: '[]', provenance: '[]' },
    ];
    qMock.mockResolvedValueOnce(rows).mockResolvedValue([]);
    const res = await request(app()).get('/v1/projects/p1/tools?limit=1');
    expect(res.status).toBe(200);
    expect(res.body.tools).toHaveLength(1);
    expect(res.body.tools[0].name).toBe('aTool');
    expect(res.body.pagination).toMatchObject({ limit: 1, has_more: true });
    expect(typeof res.body.pagination.next_cursor).toBe('string');
    const [sql] = qMock.mock.calls[0]!;
    expect(String(sql)).toContain('ORDER BY name ASC, id ASC');
  });
});

describe('PATCH /v1/projects/tools/:toolId (approve)', () => {
  it('copies recovery rules to the bumped version in one transaction (BE-00)', async () => {
    const ruleRow = { condition: 'RATE_LIMITED', detection_rule: { status_code: 429 }, behavior: 'retry_changed',
      recovery_action: 'backoff_retry', max_attempts: 3, backoff_ms: 2000, user_message: 'slow down' };
    const queryMock = vi.fn(async (text: string, _params?: unknown[]) => {
      if (text.includes('RETURNING version')) return { rows: [{ version: 2 }] };
      if (text.includes('FROM tool_recovery_rules')) return { rows: [ruleRow] };
      return { rows: [] };
    });
    withTxMock.mockImplementation(async (fn: any) => fn({ query: queryMock }));
    oneMock
      .mockResolvedValueOnce({ id: 'p1', customer_id: 'c1' }) // requireProjectRole resolver
      .mockResolvedValueOnce({ id: 't1', project_id: 'p1', name: 'getInvoices', version: 1 }) // existing
      .mockResolvedValueOnce({ id: 't1', project_id: 'p1', name: 'getInvoices', version: 2 }); // after

    const res = await request(app()).patch('/v1/projects/tools/t1').send({ status: 'approved' });

    expect(res.status).toBe(200);
    expect(res.body.tool.version).toBe(2);
    const ruleInsert = queryMock.mock.calls.find((c) => String(c[0]).includes('INSERT INTO tool_recovery_rules'))!;
    expect(ruleInsert[1]![2]).toBe(2); // copied to the NEW version
    expect(ruleInsert[1]![3]).toBe('RATE_LIMITED');
    expect(auditMock).toHaveBeenCalledWith('p1', 'tool.approved', 'canonical_tool', 't1', expect.anything());
  });

  it('404s for an unknown tool', async () => {
    oneMock.mockResolvedValue(undefined);
    const res = await request(app()).patch('/v1/projects/tools/nope').send({ status: 'approved' });
    expect(res.status).toBe(404);
  });

  it('accepts effect class + confirmation edits and bumps the version like approving', async () => {
    const queryMock = vi.fn(async (text: string, _params?: unknown[]) => {
      if (text.includes('RETURNING version')) return { rows: [{ version: 2 }] };
      if (text.includes('FROM tool_recovery_rules')) return { rows: [] };
      return { rows: [] };
    });
    withTxMock.mockImplementation(async (fn: any) => fn({ query: queryMock }));
    oneMock
      .mockResolvedValueOnce({ id: 'p1', customer_id: 'c1' }) // requireProjectRole resolver
      .mockResolvedValueOnce({ id: 't1', project_id: 'p1', name: 'doThing', version: 1,
        effect_classes: '["mutating"]', confirmation_required: false }) // existing
      .mockResolvedValueOnce({ id: 't1', project_id: 'p1', name: 'doThing', version: 2 }); // after

    const res = await request(app()).patch('/v1/projects/tools/t1')
      .send({ effect_classes: ['destructive'], confirmation_required: true });

    expect(res.status).toBe(200);
    const update = queryMock.mock.calls.find((c) => String(c[0]).includes('UPDATE canonical_tools'))!;
    expect(String(update[0])).toContain('version = version + 1');
    expect(res.body.tool.version).toBe(2);
  });

  it('rejects unknown effect classes', async () => {
    oneMock.mockResolvedValue({ id: 'p1', customer_id: 'c1' }); // role resolver passes; schema rejects
    const res = await request(app()).patch('/v1/projects/tools/t1')
      .send({ effect_classes: ['nuke_everything'] });
    expect(res.status).toBe(400);
  });
});

describe('GET /v1/me', () => {
  it('returns the user, memberships, and writable flags', async () => {
    const res = await request(app()).get('/v1/me');
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ id: 'u1', is_platform_admin: false });
    expect(res.body.memberships).toHaveLength(2);
    expect(res.body.memberships[0]).toMatchObject({ customer_id: 'c1', role: 'owner', writable: true });
    // Viewer in a trial-expired customer cannot write.
    expect(res.body.memberships[1]).toMatchObject({ customer_id: 'c2', role: 'viewer', writable: false });
  });
});

describe('PATCH /v1/projects/:id role gating (BE-13)', () => {
  function appWithRole(role: string) {
    const a = express();
    a.use(express.json());
    const m = { ...memberships[0], role };
    a.use((req: any, _res, next) => { req.auth = { ...auth, memberships: [m] }; next(); });
    a.use('/v1/projects', projectsRouter);
    return a;
  }

  it('403s for viewers (read-only role)', async () => {
    oneMock.mockResolvedValue({ id: 'p1', customer_id: 'c1', name: 'Old' });
    const res = await request(appWithRole('viewer')).patch('/v1/projects/p1').send({ name: 'New' });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/Requires role/);
    expect(execMock).not.toHaveBeenCalled();
  });

  it('lets editors through to the handler', async () => {
    oneMock.mockResolvedValue({ id: 'p1', customer_id: 'c1', name: 'New' });
    const res = await request(appWithRole('editor')).patch('/v1/projects/p1').send({ name: 'New' });
    expect(res.status).toBe(200);
    expect(res.body.project.name).toBe('New');
  });

  it('404s for unknown projects before any role check', async () => {
    oneMock.mockResolvedValue(undefined);
    const res = await request(appWithRole('owner')).patch('/v1/projects/nope').send({ name: 'New' });
    expect(res.status).toBe(404);
  });
});
