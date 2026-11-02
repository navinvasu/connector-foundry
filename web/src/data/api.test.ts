import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  ApiError,
  api,
  deleteProject,
  mapBackendProject,
  mapBackendEvalRun,
  mapReviewFinding,
  type DashboardReviewItem,
  needsOrganization,
  shellFor,
  isSoleActiveOwner,
  type BackendProject,
  type BackendEvalRun,
  type BackendEvalResult,
  type Me,
  type Member,
} from './api';

function project(over: Partial<BackendProject> = {}): BackendProject {
  return {
    id: 'p1', name: 'Acme Billing', description: 'Billing connector',
    targets: ['mcp', 'openai'], customer_id: 'c1', customer_name: 'Demo',
    status: 'active', created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    operations_count: 3, tools_total: 3, tools_approved: 1,
    open_review_items: 2, latest_source_type: 'openapi_url', latest_source_location: 'https://api.acme.test/openapi.yaml',
    ...over,
  };
}

function run(over: Partial<BackendEvalRun> = {}): BackendEvalRun {
  return {
    id: 'run-1', trigger: 'manual', status: 'failed',
    summary: {}, started_at: new Date().toISOString(), finished_at: new Date().toISOString(),
    ...over,
  };
}

function result(over: Partial<BackendEvalResult> = {}): BackendEvalResult {
  return {
    id: 'r1', tool_id: 't1', suite: 'contract', scenario: 'happy_path_2xx_json',
    passed: true, latency_ms: 120, detail: { url: 'https://api.test/forecast', status: 200 },
    ...over,
  };
}

describe('mapBackendProject', () => {
  it('maps the summary fields the screens render', () => {
    const p = mapBackendProject(project());
    expect(p).toMatchObject({
      id: 'p1', name: 'Acme Billing',
      targets: ['mcp', 'openai'],
      status: 'in_review',
      toolsApproved: 1, toolsTotal: 3, operationsCount: 3,
      blockerCount: 2,
      sourceKind: 'openapi-url',
      sourceDetail: 'https://api.acme.test/openapi.yaml',
      customerId: 'c1', customerName: 'Demo',
    });
  });

  it('drops unknown targets and falls back to all three targets when empty', () => {
    expect(mapBackendProject(project({ targets: ['openai', 'bogus'] })).targets).toEqual(['openai']);
    expect(mapBackendProject(project({ targets: [] })).targets).toEqual(['mcp', 'openai', 'muse']);
    expect(mapBackendProject(project({ targets: null })).targets).toEqual(['mcp', 'openai', 'muse']);
  });

  it('marks projects with no operations as drafts', () => {
    expect(mapBackendProject(project({ operations_count: 0 })).status).toBe('draft');
  });

  it('maps upload sources and falls back on blurb', () => {
    const p = mapBackendProject(project({ latest_source_type: 'openapi_file', latest_source_location: 'acme.yaml', description: '  ' }));
    expect(p.sourceKind).toBe('upload');
    expect(p.blurb).toBe('No description yet.');
  });

  it('maps Postman sources (IA-02)', () => {
    const p = mapBackendProject(project({ latest_source_type: 'postman' }));
    expect(p.sourceKind).toBe('postman');
  });

  it('leaves sourceKind undefined for unknown source types', () => {
    expect(mapBackendProject(project({ latest_source_type: 'something_else' })).sourceKind).toBeUndefined();
  });
});

describe('needsOrganization (FE-07)', () => {
  const me = (over: Partial<Me> = {}): Me => ({
    user: { id: 'u-1', email: 'n@acme.test', full_name: 'N', is_platform_admin: false },
    memberships: [],
    ...over,
  });
  const membership = (status: string) => ({
    customer_id: 'c-1', customer_name: 'Acme', customer_status: 'trialing', plan_id: 'trial',
    plan_name: 'Trial', role: 'owner' as const, membership_status: status, writable: true,
    project_cap: 2, telemetry_retention_days: 30, trial_ends_at: null,
  });

  it('is true for a signed-in user with no memberships', () => {
    expect(needsOrganization(me())).toBe(true);
  });

  it('is false once the user holds an active membership', () => {
    expect(needsOrganization(me({ memberships: [membership('active')] }))).toBe(false);
  });

  it('treats an invited-only membership as still needing an organization', () => {
    expect(needsOrganization(me({ memberships: [membership('invited')] }))).toBe(true);
  });

  it('never sends platform admins (or an unloaded /me) to the step', () => {
    expect(needsOrganization(me({
      user: { id: 'a-1', email: 'op@foundry.test', full_name: null, is_platform_admin: true },
    }))).toBe(false);
    expect(needsOrganization(null)).toBe(false);
  });
});

describe('shellFor (FE-13)', () => {
  const me = (over: Partial<Me> = {}): Me => ({
    user: { id: 'u-1', email: 'n@acme.test', full_name: 'N', is_platform_admin: false },
    memberships: [],
    ...over,
  });
  const admin = { id: 'a-1', email: 'op@foundry.test', full_name: null, is_platform_admin: true };
  const membership = (status: string) => ({
    customer_id: 'c-1', customer_name: 'Acme', customer_status: 'trialing', plan_id: 'trial',
    plan_name: 'Trial', role: 'owner' as const, membership_status: status, writable: true,
    project_cap: 2, telemetry_retention_days: 30, trial_ends_at: null,
  });

  it('fails closed on Admin while identity is unloaded', () => {
    expect(shellFor(null)).toEqual({ showAdmin: false, showTenant: true, landing: '/dashboard' });
  });

  it('gives workspace members the tenant plane only', () => {
    expect(shellFor(me({ memberships: [membership('active')] })))
      .toEqual({ showAdmin: false, showTenant: true, landing: '/dashboard' });
  });

  it('gives operators with no membership the Admin plane only, landed on Customers', () => {
    expect(shellFor(me({ user: admin })))
      .toEqual({ showAdmin: true, showTenant: false, landing: '/admin/customers' });
  });

  it('shows both planes to an admin who also holds a membership', () => {
    expect(shellFor(me({ user: admin, memberships: [membership('active')] })))
      .toEqual({ showAdmin: true, showTenant: true, landing: '/dashboard' });
  });

  it('sends identity-less non-admins to organization creation', () => {
    expect(shellFor(me())).toEqual({ showAdmin: false, showTenant: false, landing: '/organizations/new' });
    expect(shellFor(me({ memberships: [membership('invited')] })).showTenant).toBe(false);
  });
});

describe('isSoleActiveOwner (FE-08)', () => {
  const member = (over: Partial<Member> = {}): Member => ({
    membership_id: 'm-1', user_id: 'u-1', email: 'n@acme.test', full_name: null,
    role: 'owner', status: 'active', joined_at: null, invite_expires_at: null,
    last_login_at: null, ...over,
  });

  it('is true for the only active owner', () => {
    const owner = member();
    expect(isSoleActiveOwner([owner, member({ user_id: 'u-2', role: 'editor' })], owner)).toBe(true);
  });

  it('is false once a second active owner exists', () => {
    const owner = member();
    expect(isSoleActiveOwner([owner, member({ user_id: 'u-2' })], owner)).toBe(false);
  });

  it('ignores invited/suspended owners and non-owner members', () => {
    const owner = member();
    const roster = [
      owner,
      member({ user_id: 'u-2', status: 'invited' }),
      member({ user_id: 'u-3', status: 'suspended' }),
    ];
    expect(isSoleActiveOwner(roster, owner)).toBe(true);
    expect(isSoleActiveOwner(roster, roster[1])).toBe(false);
    expect(isSoleActiveOwner(roster, member({ user_id: 'u-4', role: 'viewer' }))).toBe(false);
  });
});

describe('mapBackendEvalRun', () => {
  it('maps scenarios with labels, categories, and pass/fail counts', () => {
    const r = mapBackendEvalRun(run(), [
      result({ scenario: 'happy_path_2xx_json', suite: 'contract', passed: true }),
      result({ id: 'r2', scenario: 'invalid_input_handled', suite: 'recovery', passed: false, detail: { status: 500 } }),
    ]);
    expect(r.scenarioCount).toBe(2);
    expect(r.passCount).toBe(1);
    expect(r.failCount).toBe(1);
    expect(r.scenarios[0]).toMatchObject({
      name: 'Happy path returns 2xx JSON',
      category: 'arguments',
      result: 'pass',
    });
    expect(r.scenarios[1]).toMatchObject({
      name: 'Invalid input handled (recovery)',
      category: 'recovery',
      result: 'fail',
    });
    expect(r.byCategory).toEqual([
      { category: 'arguments', pass: 1, total: 1 },
      { category: 'recovery', pass: 0, total: 1 },
    ]);
  });

  it('diagnoses the defaulted-200 contract divergence', () => {
    const r = mapBackendEvalRun(run(), [
      result({ scenario: 'missing_params_handled', passed: true, detail: { status: 200, behavior: 'defaulted_200' } }),
    ]);
    expect(r.scenarios[0]!.diagnosis).toMatch(/confirm the contract in review/);
    expect(r.scenarios[0]!.actual).toBe('HTTP 200 (defaulted_200)');
  });

  it('diagnoses unexpected HTTP statuses on failures', () => {
    const r = mapBackendEvalRun(run(), [
      result({ passed: false, detail: { status: 500 } }),
    ]);
    expect(r.scenarios[0]!.diagnosis).toBe('Unexpected HTTP 500 for this scenario.');
  });

  it('surfaces fetch errors as the scenario actual + diagnosis', () => {
    const r = mapBackendEvalRun(run(), [
      result({ passed: false, detail: { error: 'socket hangup' } }),
    ]);
    expect(r.scenarios[0]!.actual).toBe('socket hangup');
    expect(r.scenarios[0]!.diagnosis).toBe('Request failed: socket hangup');
  });

  it('renders the recovery mapping in the actual column', () => {
    const r = mapBackendEvalRun(run(), [
      result({ scenario: 'invalid_input_handled', detail: { status: 400, mapped_condition: 'BAD_REQUEST' } }),
    ]);
    expect(r.scenarios[0]!.actual).toBe('HTTP 400 → BAD_REQUEST');
  });

  it('falls back to the raw scenario id for unknown scenarios', () => {
    const r = mapBackendEvalRun(run(), [result({ scenario: 'custom_probe', suite: 'mystery' })]);
    expect(r.scenarios[0]!.name).toBe('custom_probe');
    expect(r.scenarios[0]!.category).toBe('execution'); // unknown suite default
  });

  it('handles an empty result set', () => {
    const r = mapBackendEvalRun(run(), []);
    expect(r).toMatchObject({ scenarioCount: 0, passCount: 0, failCount: 0, byCategory: [] });
  });

  it('stamps the stable cross-run key (EV-02)', () => {
    const r = mapBackendEvalRun(run(), [result({ tool_id: 'tool-9', suite: 'auth', scenario: 'credential_configured' })]);
    expect(r.scenarios[0]!.key).toBe('tool-9|auth|credential_configured');
    expect(r.scenarios[0]!.name).toBe('credential_configured');
    expect(r.scenarios[0]!.category).toBe('safety');
  });

  it('labels the write-safety scenarios and diagnoses their failures (EV-06)', () => {
    const r = mapBackendEvalRun(run(), [
      result({ id: 's1', suite: 'safety', scenario: 'write_invalid_payload_rejected', passed: false, detail: { status: 200 } }),
      result({ id: 's2', suite: 'safety', scenario: 'write_replay_idempotent', passed: true, detail: { status: 200 } }),
      result({ id: 's3', suite: 'safety', scenario: 'write_confirmation_contract', passed: false, detail: {} }),
    ]);
    expect(r.scenarios.map((s) => s.name)).toEqual([
      'Write rejects a wrong-type payload',
      'Idempotent write replays safely',
      'Write requires confirmation',
    ]);
    expect(r.scenarios.every((s) => s.category === 'safety')).toBe(true);
    expect(r.scenarios[0]!.expected).toMatch(/wrong-type payload/);
    expect(r.scenarios[0]!.diagnosis).toMatch(/must never land/);
    expect(r.scenarios[2]!.diagnosis).toMatch(/without asking the user first/);
    expect(r.byCategory).toEqual([{ category: 'safety', pass: 1, total: 3 }]);
  });

  it('renders customer scenarios with their pinned expectation (EV-04)', () => {
    const r = mapBackendEvalRun(run(), [
      result({
        id: 'c1', suite: 'custom', scenario: 'Required args happy path', passed: false,
        detail: {
          status: 200, expect_status: 200, expect_body_keys: ['current'],
          body_keys: ['daily'], failures: ['Expected response key "current" is missing.'],
        },
      }),
    ]);
    expect(r.scenarios[0]).toMatchObject({
      name: 'Required args happy path', category: 'execution', result: 'fail',
      expected: 'HTTP 200 with keys current',
      actual: 'HTTP 200, keys: daily',
      diagnosis: 'Expected response key "current" is missing.',
      key: 't1|custom|Required args happy path',
    });
  });
});

describe('listProjectTools (BE-08 paging)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function page(body: unknown) {
    return { ok: true, status: 200, headers: { get: () => null }, json: () => Promise.resolve(body) };
  }

  it('follows cursor pages so counts never stick at one page', async () => {
    const { listProjectTools } = await import('./api');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(page({
        tools: [{ id: 't1', name: 'a', status: 'approved' }],
        pagination: { limit: 1, has_more: true, next_cursor: 'cursor-2' },
      }))
      .mockResolvedValueOnce(page({
        tools: [{ id: 't2', name: 'b', status: 'candidate' }],
        pagination: { limit: 1, has_more: false, next_cursor: null },
      }));
    vi.stubGlobal('fetch', fetchMock);
    const { tools } = await listProjectTools('p1');
    expect(tools.map((t) => t.name)).toEqual(['a', 'b']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toMatch(/cursor=cursor-2/);
  });

  it('treats a response without pagination as the whole set', async () => {
    const { listProjectTools } = await import('./api');
    const fetchMock = vi.fn().mockResolvedValueOnce(page({ tools: [{ id: 't1', name: 'a', status: 'approved' }] }));
    vi.stubGlobal('fetch', fetchMock);
    const { tools } = await listProjectTools('p1');
    expect(tools).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('deleteProject', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('issues DELETE /v1/projects/:id and returns the deleted counts', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, status: 200, headers: { get: () => null },
      json: () => Promise.resolve({ ok: true, project_id: 'p1', deleted: { tools: 3 } }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const res = await deleteProject('p1');
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/v1\/projects\/p1$/),
      expect.objectContaining({ method: 'DELETE' }),
    );
    expect(res.deleted).toEqual({ tools: 3 });
  });
});

describe('credentials helpers (item 5)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function ok(body: unknown) {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, headers: { get: () => null }, json: () => Promise.resolve(body) });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('saveCredential POSTs label + value and returns the metadata', async () => {
    const { saveCredential } = await import('./api');
    const fetchMock = ok({ credential: { id: 'c1', label: 'Twelve Data' } });
    const res = await saveCredential('p1', 'Twelve Data', 'secret-value');
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/v1\/projects\/p1\/credentials$/),
      expect.objectContaining({ method: 'POST' }),
    );
    expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string))
      .toEqual({ label: 'Twelve Data', value: 'secret-value' });
    expect(res.credential.label).toBe('Twelve Data');
  });

  it('rotateCredential POSTs only the replacement value to the credential id', async () => {
    const { rotateCredential } = await import('./api');
    const fetchMock = ok({ credential: { id: 'c1', status: 'active' } });
    await rotateCredential('p1', 'c1', 'new-secret');
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/v1\/projects\/p1\/credentials\/c1\/rotate$/),
      expect.objectContaining({ method: 'POST' }),
    );
    expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string))
      .toEqual({ value: 'new-secret' });
  });

  it('listCredentials GETs the project credentials', async () => {
    const { listCredentials } = await import('./api');
    const fetchMock = ok({ credentials: [] });
    const res = await listCredentials('p1');
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/v1\/projects\/p1\/credentials$/),
      expect.anything(),
    );
    expect(res.credentials).toEqual([]);
  });
});

describe('api() ApiError (FE-03)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const jsonRes = (status: number, body: unknown) =>
    vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null },
      json: () => Promise.resolve(body),
    });

  it('throws an ApiError carrying status, code, and the response body', async () => {
    vi.stubGlobal('fetch', jsonRes(409, {
      error: 'Project limit reached (5/5). Upgrade the plan to add more projects.',
      code: 'project_limit_reached',
      plan_name: 'Starter',
      projects_used: 5,
      project_cap: 5,
    }));
    const err: unknown = await api('/v1/projects', { method: 'POST' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toBeInstanceOf(Error);
    expect((err as ApiError).status).toBe(409);
    expect((err as ApiError).code).toBe('project_limit_reached');
    expect((err as ApiError).message).toContain('Project limit reached');
    expect((err as ApiError).details).toMatchObject({ projects_used: 5, project_cap: 5 });
  });

  it('falls back to a generic message with null code when the body is empty', async () => {
    vi.stubGlobal('fetch', jsonRes(500, {}));
    const err: unknown = await api('/v1/projects').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(500);
    expect((err as ApiError).code).toBeNull();
    expect((err as ApiError).message).toBe('Request failed: 500');
  });
});

describe('mapReviewFinding (D-87: the review queue is the API\'s review items)', () => {
  const item = (over: Partial<DashboardReviewItem> = {}): DashboardReviewItem => ({
    id: 'r1', kind: 'risk', title: 'Unverified host', status: 'open', severity: null,
    recommendation: 'Resolve before release', evidence: { code: 'host', detail: 'Base URL is HTTP', operationRef: 'GET /x' },
    tool_id: null, created_at: '2026-10-24T00:00:00Z', ...over,
  });

  it('maps a risk to an open blocker with its evidence and suggested fix', () => {
    expect(mapReviewFinding(item())).toEqual({
      id: 'r1', severity: 'blocker', code: 'HOST', title: 'Unverified host',
      detail: 'Base URL is HTTP', recommendation: 'Resolve before release',
      operationRef: 'GET /x', status: 'open', toolId: null,
    });
  });

  it('carries the backend tool id so eval findings link to their tool', () => {
    expect(mapReviewFinding(item({ tool_id: 'tool-9' })).toolId).toBe('tool-9');
  });

  it('maps an ambiguity to a warning and a closed item to resolved', () => {
    const f = mapReviewFinding(item({ kind: 'ambiguity', status: 'dismissed', evidence: {} }));
    expect(f.severity).toBe('warning');
    expect(f.status).toBe('resolved');
    expect(f.code).toBe('SCHEMA');
    expect(f.detail).toBe('');
    expect(f.recommendation).toBe('Resolve before release');
  });

  it('maps AUTH/ERROR ambiguities to informational findings', () => {
    for (const code of ['AUTH', 'ERROR']) {
      const f = mapReviewFinding(item({ kind: 'ambiguity', evidence: { code, detail: 'd' } }));
      expect(f.severity).toBe('info');
    }
    const actionable = mapReviewFinding(item({ kind: 'ambiguity', evidence: { code: 'SCHEMA', detail: 'd' } }));
    expect(actionable.severity).toBe('warning');
  });

  it('keeps an acknowledged status acknowledged (not resolved)', () => {
    const f = mapReviewFinding(item({ kind: 'ambiguity', status: 'acknowledged', evidence: { code: 'ERROR', detail: 'd' } }));
    expect(f.status).toBe('acknowledged');
    expect(f.severity).toBe('info');
  });
});
