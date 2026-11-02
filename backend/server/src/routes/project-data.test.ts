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

import { one, q, withTx } from '../db.js';
import { projectsRouter } from './tools.js';
import { errorHandler } from '../errors.js';

const oneMock = vi.mocked(one);
const qMock = vi.mocked(q);
const withTxMock = vi.mocked(withTx);

const baseMembership = {
  customerId: 'c1', customerName: 'Demo', customerStatus: 'active', planId: 'starter',
  planName: 'Starter', seatCap: 3, projectCap: 5, telemetryRetentionDays: 90,
  trialEndsAt: null, pastDueSince: null, membershipStatus: 'active',
};

function appWith(role: string, customerStatus = 'active') {
  const a = express();
  a.use(express.json());
  const m = { ...baseMembership, role, customerStatus };
  const auth = {
    userId: 'u1', email: 'dev@x.test', fullName: 'Dev',
    isPlatformAdmin: false, memberships: [m],
  };
  a.use((req: any, _res, next) => { req.auth = auth; next(); });
  a.use('/v1/projects', projectsRouter);
  a.use(errorHandler);
  return a;
}

const countsRow = {
  project_name: 'Acme', sources: 1, operations: 2, tools: 1, recovery_rules: 1,
  review_items: 1, eval_runs: 1, eval_results: 2, releases: 1, release_tools: 1,
  jobs: 1, telemetry_events: 3, audit_events: 2, credentials: 0, eval_custom_scenarios: 0,
  drift_checks: 0, drift_alerts: 0,
};

const txQueryMock = vi.fn(async (text: string, _params?: unknown[]) => {
  if (text.includes('AS project_name')) return { rows: [countsRow], rowCount: 1 };
  return { rows: [], rowCount: 1 };
});

// Export reads dispatch by table so test order doesn't matter.
function mockExportReads() {
  qMock.mockImplementation(async (sql: string) => {
    const s = String(sql);
    if (s.includes('FROM api_sources')) return [{ id: 's1', spec_body: '{"openapi":"3.0.0"}' }];
    if (s.includes('FROM operations')) return [{ id: 'o1', operation_id: 'getX' }];
    if (s.includes('FROM canonical_tools')) {
      return [{
        id: 't1', name: 'getX', version: 1, input_schema: '{"type":"object"}',
        upstream: '{"method":"GET"}', effect_classes: '["read_only"]',
        required_scopes: '[]', provenance: '[]',
      }];
    }
    if (s.includes('FROM tool_recovery_rules')) return [{ condition: 'RATE_LIMITED' }];
    if (s.includes('FROM review_items')) return [{ id: 'ri1', evidence: '{"a":1}' }];
    if (s.includes('FROM eval_results')) return [{ id: 'res1', passed: 1, detail: '{"ms":5}' }];
    if (s.includes('FROM eval_runs')) return [{ id: 'er1', summary: '{"passed":3}' }];
    if (s.includes('FROM release_tools')) return [{ tool_id: 't1', tool_snapshot: '{"name":"getX"}' }];
    if (s.includes('FROM releases')) return [{ id: 'rel1', manifest: '{"tools":[]}' }];
    if (s.includes('FROM jobs')) return [{ id: 'j1', payload: '{}', progress: null, result: null }];
    if (s.includes('FROM telemetry_events')) return [{ id: 'te1', tool_name: 'getX' }];
    if (s.includes('FROM project_credentials')) return [{ id: 'c1', label: 'prod key', key_fingerprint: 'ab'.repeat(32), status: 'active', vault_handle: 'cfv1.should-never-export' }];
    if (s.includes('FROM eval_custom_scenarios')) return [{ id: 'es1', name: 'Required args happy path', given_args: '{"latitude":52.52}', expect_body_keys: '["current"]' }];
    if (s.includes('FROM drift_checks')) return [{ id: 'dc1', summary: '{"tools_checked":1}' }];
    if (s.includes('FROM drift_alerts')) return [{ id: 'da1', tool_name: 'getX', evidence: '{"failed_scenarios":[]}' }];
    return [];
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  uidN = 0;
  oneMock.mockResolvedValue(undefined);
  qMock.mockResolvedValue([]);
  txQueryMock.mockClear();
  txQueryMock.mockImplementation(async (text: string, _params?: unknown[]) => {
    if (text.includes('AS project_name')) return { rows: [countsRow], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  });
  withTxMock.mockImplementation(async (fn: any) => fn({ query: txQueryMock }));
});

describe('GET /v1/projects/:id/export (SE-04)', () => {
  it('404s when the project is not visible to the caller', async () => {
    oneMock.mockResolvedValue(undefined);
    const res = await request(appWith('owner')).get('/v1/projects/nope/export');
    expect(res.status).toBe(404);
    expect(qMock).not.toHaveBeenCalled();
  });

  it('returns the full project as a downloadable JSON document', async () => {
    oneMock.mockResolvedValue({
      id: 'p1', name: 'Acme', customer_id: 'c1', targets: '["mcp","openai"]',
    });
    mockExportReads();
    const res = await request(appWith('owner')).get('/v1/projects/p1/export');
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition'])
      .toBe('attachment; filename="connector-foundry-project-p1-export.json"');
    // Visibility scoping: project lookup binds the caller's customer ids.
    expect(oneMock.mock.calls[0]![1]).toEqual(['p1', ['c1'], false]);
    expect(res.body.export_version).toBe(1);
    expect(typeof res.body.exported_at).toBe('string');
    expect(res.body.project.targets).toEqual(['mcp', 'openai']);
    // JSONB columns arrive parsed, nested children attached to their parents.
    expect(res.body.sources[0].spec_body).toEqual({ openapi: '3.0.0' });
    expect(res.body.tools[0].input_schema).toEqual({ type: 'object' });
    expect(res.body.tools[0].recovery_rules).toEqual([{ condition: 'RATE_LIMITED' }]);
    expect(res.body.review_items[0].evidence).toEqual({ a: 1 });
    expect(res.body.eval_runs[0].summary).toEqual({ passed: 3 });
    expect(res.body.eval_runs[0].results[0]).toMatchObject({ passed: true, detail: { ms: 5 } });
    expect(res.body.releases[0].manifest).toEqual({ tools: [] });
    expect(res.body.releases[0].tools[0].tool_snapshot).toEqual({ name: 'getX' });
    expect(res.body.counts).toEqual({
      sources: 1, operations: 1, tools: 1, review_items: 1,
      eval_runs: 1, releases: 1, jobs: 1, telemetry_events: 1, credentials: 1,
      eval_custom_scenarios: 1, drift_checks: 1, drift_alerts: 1,
    });
    expect(res.body.eval_custom_scenarios[0].given_args).toEqual({ latitude: 52.52 });
    expect(res.body.eval_custom_scenarios[0].expect_body_keys).toEqual(['current']);
    // SE-04 / AB-02: the export carries credential metadata only — the
    // vault envelope is never exported even when the row has one.
    expect(res.body.credentials[0]).toMatchObject({ label: 'prod key', status: 'active' });
    expect(res.body.credentials[0]).not.toHaveProperty('vault_handle');
  });

  it('lets viewers export (read access) — only deletion is owner-gated', async () => {
    oneMock.mockResolvedValue({ id: 'p1', name: 'Acme', customer_id: 'c1', targets: null });
    mockExportReads();
    const res = await request(appWith('viewer')).get('/v1/projects/p1/export');
    expect(res.status).toBe(200);
    expect(res.body.project.id).toBe('p1');
  });
});

describe('DELETE /v1/projects/:id (SE-04)', () => {
  it('deletes non-cascading rows, then the project, then writes a tombstone — in one tx', async () => {
    oneMock.mockResolvedValue({ id: 'p1', customer_id: 'c1' }); // requireProjectRole resolver
    const res = await request(appWith('owner')).delete('/v1/projects/p1');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.project_id).toBe('p1');
    const { project_name: _omit, ...expectedCounts } = countsRow;
    expect(res.body.deleted).toEqual(expectedCounts);

    const sqls = txQueryMock.mock.calls.map((c) => String(c[0]));
    const idx = (frag: string) => sqls.findIndex((s) => s.includes(frag));
    expect(idx('DELETE FROM telemetry_events')).toBeGreaterThan(-1);
    expect(idx('DELETE FROM telemetry_events')).toBeLessThan(idx('DELETE FROM audit_events WHERE'));
    expect(idx('DELETE FROM audit_events WHERE')).toBeLessThan(idx('DELETE FROM projects'));
    expect(idx('DELETE FROM projects')).toBeLessThan(idx('INSERT INTO audit_events'));

    const tomb = txQueryMock.mock.calls.find((c) => String(c[0]).includes('INSERT INTO audit_events'))!;
    expect(String(tomb[0])).toContain('NULL'); // project_id is a NULL literal — the row survives the deletion
    expect(tomb[1]![1]).toBe('u1'); // actor_user_id
    expect(tomb[1]![2]).toBe('p1'); // entity id
    const meta = JSON.parse(tomb[1]![3] as string);
    expect(meta.project_name).toBe('Acme');
    expect(meta.customer_id).toBe('c1');
    expect(meta.deleted_counts).toEqual(expectedCounts);
  });

  it('403s for editors — deletion is owner-only', async () => {
    oneMock.mockResolvedValue({ id: 'p1', customer_id: 'c1' });
    const res = await request(appWith('editor')).delete('/v1/projects/p1');
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/Requires role/);
    expect(withTxMock).not.toHaveBeenCalled();
  });

  it('403s for viewers', async () => {
    oneMock.mockResolvedValue({ id: 'p1', customer_id: 'c1' });
    const res = await request(appWith('viewer')).delete('/v1/projects/p1');
    expect(res.status).toBe(403);
    expect(withTxMock).not.toHaveBeenCalled();
  });

  it('403s for an owner of a suspended customer (writes disabled)', async () => {
    oneMock.mockResolvedValue({ id: 'p1', customer_id: 'c1' });
    const res = await request(appWith('owner', 'suspended')).delete('/v1/projects/p1');
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/writes are disabled/);
    expect(withTxMock).not.toHaveBeenCalled();
  });

  it('404s for outsiders without leaking existence', async () => {
    oneMock.mockResolvedValue(undefined);
    const res = await request(appWith('owner')).delete('/v1/projects/nope');
    expect(res.status).toBe(404);
    expect(withTxMock).not.toHaveBeenCalled();
  });

  it('404s and writes no tombstone when the project row vanished mid-transaction', async () => {
    oneMock.mockResolvedValue({ id: 'p1', customer_id: 'c1' });
    txQueryMock.mockImplementation(async (text: string, _params?: unknown[]) => {
      if (text.includes('AS project_name')) return { rows: [countsRow], rowCount: 1 };
      if (text.includes('DELETE FROM projects')) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 1 };
    });
    const res = await request(appWith('owner')).delete('/v1/projects/p1');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('project_not_found');
    const sqls = txQueryMock.mock.calls.map((c) => String(c[0]));
    expect(sqls.some((s) => s.includes('INSERT INTO audit_events'))).toBe(false);
  });
});
