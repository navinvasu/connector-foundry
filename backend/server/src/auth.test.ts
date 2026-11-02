import { describe, it, expect, vi, beforeEach } from 'vitest';

// SE-07 inverted the CF_DEV_AUTH default to OFF; these suites exercise the
// dev-auth path, so pin it on before auth.js evaluates (the "off" test
// below re-imports with it false).
vi.hoisted(() => { process.env.CF_DEV_AUTH = 'true'; });

vi.mock('./db.js', () => ({
  one: vi.fn(),
  q: vi.fn(),
  exec: vi.fn(),
  uid: () => 'uid-1',
}));

import { one, q, exec } from './db.js';
import {
  requireAuth,
  requirePlatformAdmin,
  requireCustomerRole,
  requireProjectRole,
  requireProjectRead,
  acceptPendingInvites,
  membershipIn,
  customerWritable,
  type AuthContext,
  type Membership,
} from './auth.js';

const oneMock = vi.mocked(one);
const qMock = vi.mocked(q);
const execMock = vi.mocked(exec);

function res(): any {
  return { status: vi.fn().mockReturnThis(), json: vi.fn() };
}

const member = (over: Partial<Membership> = {}): Membership => ({
  customerId: 'c1', customerName: 'Acme', customerStatus: 'active',
  planId: 'starter', planName: 'Starter', seatCap: 3, projectCap: 5,
  telemetryRetentionDays: 90, trialEndsAt: null, pastDueSince: null,
  role: 'owner', membershipStatus: 'active',
  ...over,
});

const authCtx = (over: Partial<AuthContext> = {}): AuthContext => ({
  userId: 'u1', email: 'dev@connectorfoundry.local', fullName: 'Dev',
  isPlatformAdmin: false, memberships: [],
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  oneMock.mockResolvedValue(undefined);
  qMock.mockResolvedValue([]);
});

describe('requireAuth (dev bypass)', () => {
  it('seeds and attaches the dev platform-admin identity', async () => {
    const userRow = { id: 'u1', email: 'dev@connectorfoundry.local', full_name: 'Dev', is_platform_admin: true };
    const custRow = { id: 'c1', name: 'Dev Workspace', slug: 'dev-workspace' };
    oneMock.mockImplementation(async (text: string) => {
      if (text.includes('dev-workspace')) return undefined; // new customer
      if (text.includes('FROM users WHERE id')) return userRow;
      if (text.includes('FROM customers WHERE id')) return custRow;
      return undefined; // new user, no membership yet
    });
    qMock.mockResolvedValue([{
      customer_id: 'c1', customer_name: 'Dev Workspace', customer_status: 'active',
      plan_id: 'starter', plan_name: 'Starter', seat_cap: 3, project_cap: 5,
      telemetry_retention_days: 90, trial_ends_at: null, role: 'owner', membership_status: 'active',
    }]);

    const req: any = { headers: {} };
    const r = res();
    const next = vi.fn();
    await requireAuth(req, r, next);

    expect(next).toHaveBeenCalled();
    expect(req.auth.isPlatformAdmin).toBe(true);
    expect(req.auth.memberships).toHaveLength(1);
    expect(req.auth.memberships[0]).toMatchObject({ customerId: 'c1', role: 'owner', seatCap: 3 });
  });

  it('rejects requests without a bearer token when dev auth is off', async () => {
    const prev = process.env.CF_DEV_AUTH;
    process.env.CF_DEV_AUTH = 'false';
    vi.resetModules();
    const mod = await import('./auth.js');
    process.env.CF_DEV_AUTH = prev;

    const req: any = { headers: {} };
    const r = res();
    const next = vi.fn();
    await mod.requireAuth(req, r, next);

    // BE-05: requireAuth no longer renders the 401 itself — it delegates to
    // the central error middleware, which answers { error, code, request_id }.
    expect(r.status).not.toHaveBeenCalled();
    expect(r.json).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0][0]?.status).toBe(401);
  });
});

describe('requireAuth (dev personas — IN-09)', () => {
  const personaRow = (over: Record<string, unknown> = {}) => ({
    id: 'u9', email: 'new@acme.test', full_name: 'new', is_platform_admin: false, ...over,
  });

  it('creates a membership-less non-admin persona from x-dev-as', async () => {
    oneMock.mockImplementation(async (text: string) => {
      if (text.includes('FROM users WHERE id')) return personaRow();
      return undefined; // not found by email yet
    });
    const req: any = { headers: { 'x-dev-as': 'new@acme.test' } };
    const next = vi.fn();
    await requireAuth(req, res(), next);
    expect(next).toHaveBeenCalled();
    expect(req.auth.email).toBe('new@acme.test');
    expect(req.auth.isPlatformAdmin).toBe(false);
    expect(req.auth.memberships).toEqual([]);
    // No dev-workspace membership is seeded for personas.
    const membershipInserts = execMock.mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO customer_users'));
    expect(membershipInserts).toHaveLength(0);
  });

  it('makes an operator persona with x-dev-as-admin: 1', async () => {
    oneMock.mockImplementation(async (text: string) => {
      if (text.includes('FROM users WHERE id')) return personaRow({ is_platform_admin: true });
      return undefined;
    });
    const req: any = { headers: { 'x-dev-as': 'op@foundry.test', 'x-dev-as-admin': '1' } };
    const next = vi.fn();
    await requireAuth(req, res(), next);
    const userInsert = execMock.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO users'));
    expect(userInsert?.[1]?.[3]).toBe(true);
    expect(req.auth.isPlatformAdmin).toBe(true);
    expect(req.auth.memberships).toEqual([]);
  });

  it('reuses an existing persona user without recreating it', async () => {
    oneMock.mockImplementation(async (text: string) => {
      if (text.includes('FROM users')) return personaRow();
      return undefined;
    });
    const req: any = { headers: { 'x-dev-as': 'new@acme.test' } };
    const next = vi.fn();
    await requireAuth(req, res(), next);
    expect(req.auth.userId).toBe('u9');
    const userInserts = execMock.mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO users'));
    expect(userInserts).toHaveLength(0);
  });

  it('seeds the customer preset persona as Dev Workspace owner (no Admin)', async () => {
    oneMock.mockImplementation(async (text: string) => {
      if (text.includes('FROM users WHERE id')) return personaRow({ id: 'u7', email: 'customer@connectorfoundry.local' });
      if (text.includes('FROM users')) return undefined; // new user by email
      if (text.includes('FROM customers WHERE id')) return { id: 'c1', name: 'Dev Workspace', slug: 'dev-workspace' };
      return undefined; // no dev workspace, no membership yet
    });
    qMock.mockResolvedValue([{
      customer_id: 'c1', customer_name: 'Dev Workspace', customer_status: 'active',
      plan_id: 'starter', plan_name: 'Starter', seat_cap: 3, project_cap: 5,
      telemetry_retention_days: 90, trial_ends_at: null, role: 'owner', membership_status: 'active',
    }]);
    const req: any = { headers: { 'x-dev-as': 'customer@connectorfoundry.local' } };
    const next = vi.fn();
    await requireAuth(req, res(), next);
    expect(req.auth.isPlatformAdmin).toBe(false);
    expect(req.auth.memberships).toHaveLength(1);
    expect(req.auth.memberships[0]).toMatchObject({ customerId: 'c1', role: 'owner' });
    const membershipInserts = execMock.mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO customer_users'));
    expect(membershipInserts).toHaveLength(1);
  });

  it('ignores a malformed x-dev-as and falls back to the default dev identity', async () => {
    const userRow = { id: 'u1', email: 'dev@connectorfoundry.local', full_name: 'Dev', is_platform_admin: true };
    const custRow = { id: 'c1', name: 'Dev Workspace', slug: 'dev-workspace' };
    oneMock.mockImplementation(async (text: string) => {
      if (text.includes('dev-workspace')) return undefined;
      if (text.includes('FROM users WHERE id')) return userRow;
      if (text.includes('FROM customers WHERE id')) return custRow;
      return undefined;
    });
    const req: any = { headers: { 'x-dev-as': 'not-an-email' } };
    const next = vi.fn();
    await requireAuth(req, res(), next);
    expect(req.auth.email).toBe('dev@connectorfoundry.local');
    expect(req.auth.isPlatformAdmin).toBe(true);
  });
});

describe('acceptPendingInvites (FE-08 invite acceptance, SE-10 legacy fallback)', () => {
  it('flips unexpired invited memberships to active and clears the invite token fields', async () => {
    execMock.mockResolvedValue(2);
    const n = await acceptPendingInvites('u-invited');
    expect(n).toBe(2);
    expect(execMock).toHaveBeenCalledTimes(1);
    const [sql, params] = execMock.mock.calls[0];
    expect(sql).toContain("SET status = 'active'");
    expect(sql).toContain('invite_token_hash = NULL');
    expect(sql).toContain("status = 'invited'");
    // SE-10: sign-in alone only accepts legacy rows with no token hash —
    // hashed invites redeem through POST /v1/invites/:token/redeem only.
    expect(sql).toContain('invite_token_hash IS NULL');
    // Expired invites are not accepted — the owner must re-invite.
    expect(sql).toContain('invite_expires_at IS NULL OR invite_expires_at > now()');
    expect(params).toEqual(['u-invited']);
  });

  it('is a no-op count when the user has no pending invites', async () => {
    execMock.mockResolvedValue(0);
    await expect(acceptPendingInvites('u-none')).resolves.toBe(0);
  });

  it('runs on the dev-auth path before memberships load, so an accepted invite is in the same request context', async () => {
    const userRow = { id: 'u1', email: 'dev@connectorfoundry.local', full_name: 'Dev', is_platform_admin: true };
    const custRow = { id: 'c1', name: 'Dev Workspace', slug: 'dev-workspace' };
    oneMock.mockImplementation(async (text: string) => {
      if (text.includes('dev-workspace')) return custRow; // customer already seeded
      if (text.includes('FROM users')) return userRow;
      if (text.includes('FROM customers')) return custRow;
      return { id: 'm1' }; // dev membership already exists
    });
    qMock.mockResolvedValue([{
      customer_id: 'c1', customer_name: 'Dev Workspace', customer_status: 'active',
      plan_id: 'starter', plan_name: 'Starter', seat_cap: 3, project_cap: 5,
      telemetry_retention_days: 90, trial_ends_at: null, role: 'editor', membership_status: 'active',
    }]);

    const req: any = { headers: {} };
    const next = vi.fn();
    await requireAuth(req, res(), next);

    expect(next).toHaveBeenCalledWith();
    const acceptCall = execMock.mock.calls.findIndex(([sql]) => String(sql).includes("SET status = 'active'"));
    expect(acceptCall).toBeGreaterThanOrEqual(0);
    expect(execMock.mock.calls[acceptCall][1]).toEqual(['u1']);
    expect(execMock.mock.invocationCallOrder[acceptCall]).toBeLessThan(qMock.mock.invocationCallOrder[0]);
    expect(req.auth.memberships[0]).toMatchObject({ customerId: 'c1', role: 'editor' });
  });
});

describe('requirePlatformAdmin', () => {
  it('403s non-admins', () => {
    const req: any = { auth: authCtx({ isPlatformAdmin: false }) };
    const r = res();
    const next = vi.fn();
    requirePlatformAdmin(req, r, next);
    expect(r.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('lets platform admins through', () => {
    const req: any = { auth: authCtx({ isPlatformAdmin: true }) };
    const r = res();
    const next = vi.fn();
    requirePlatformAdmin(req, r, next);
    expect(next).toHaveBeenCalled();
  });
});

describe('requireCustomerRole', () => {
  it('lets platform admins bypass with an owner-shaped customer', () => {
    const req: any = { auth: authCtx({ isPlatformAdmin: true }), params: { id: 'c9' } };
    const r = res();
    const next = vi.fn();
    requireCustomerRole(['owner'])(req, r, next);
    expect(next).toHaveBeenCalled();
    expect(req.customer).toMatchObject({ customerId: 'c9', role: 'owner' });
  });

  it('403s callers with no membership in the customer', () => {
    const req: any = { auth: authCtx({ memberships: [member({ customerId: 'c-other' })] }), params: { id: 'c1' } };
    const r = res();
    const next = vi.fn();
    requireCustomerRole(['owner'])(req, r, next);
    expect(r.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('403s when the role is insufficient', () => {
    const req: any = { auth: authCtx({ memberships: [member({ role: 'viewer' })] }), params: { id: 'c1' } };
    const r = res();
    const next = vi.fn();
    requireCustomerRole(['owner', 'editor'])(req, r, next);
    expect(r.status).toHaveBeenCalledWith(403);
    expect(r.json).toHaveBeenCalledWith({ error: 'Requires role: owner or editor' });
  });

  it('attaches the membership when the role matches', () => {
    const m = member({ role: 'editor' });
    const req: any = { auth: authCtx({ memberships: [m] }), params: { id: 'c1' } };
    const r = res();
    const next = vi.fn();
    requireCustomerRole(['owner', 'editor'])(req, r, next);
    expect(next).toHaveBeenCalled();
    expect(req.customer).toBe(m);
  });
});

describe('membershipIn / customerWritable', () => {
  it('finds the membership by customer id', () => {
    const m = member();
    const req: any = { auth: authCtx({ memberships: [m] }) };
    expect(membershipIn(req, 'c1')).toBe(m);
    expect(membershipIn(req, 'nope')).toBeNull();
  });

  it('returns null without an auth context', () => {
    expect(membershipIn({} as any, 'c1')).toBeNull();
  });

  it.each([
    ['active', true],
    ['trialing', true],
    ['past_due', true],
    ['restricted', false],
    ['trial_expired', false],
    ['suspended', false],
  ])('customerWritable: %s -> %s', (status, expected) => {
    expect(customerWritable(member({ customerStatus: status }))).toBe(expected);
  });
});

describe('requireProjectRole (BE-13 permission matrix)', () => {
  const project = { id: 'p1', customer_id: 'c1' };
  const run = (mw: any, req: any) => {
    const resObj = res();
    const next = vi.fn();
    return mw(req, resObj, next).then(() => ({ res: resObj, next }));
  };
  const reqFor = (role: Membership['role'] | null, opts: any = {}): any => ({
    params: opts.params ?? { id: 'p1' },
    body: opts.body,
    auth: authCtx({
      isPlatformAdmin: opts.platformAdmin ?? false,
      memberships: role ? [member({ role, customerStatus: opts.customerStatus ?? 'active' })] : [],
    }),
  });

  beforeEach(() => {
    oneMock.mockResolvedValue(project);
  });

  it.each([
    ['owner', true],
    ['editor', true],
    ['viewer', false],
  ])('projectParam: %s -> %s', async (role, allowed) => {
    const { res: r, next } = await run(requireProjectRole(['owner', 'editor']), reqFor(role as any));
    if (allowed) {
      expect(next).toHaveBeenCalled();
    } else {
      expect(r.status).toHaveBeenCalledWith(403);
      expect(next).not.toHaveBeenCalled();
    }
  });

  it('attaches req.project and req.customer on success', async () => {
    const req: any = reqFor('editor');
    const { next } = await run(requireProjectRole(['owner', 'editor']), req);
    expect(next).toHaveBeenCalled();
    expect(req.project).toEqual(project);
    expect(req.customer?.role).toBe('editor');
  });

  it('404s when the caller has no membership in the owning customer', async () => {
    const { res: r, next } = await run(requireProjectRole(['owner', 'editor']), reqFor(null));
    expect(r.status).toHaveBeenCalledWith(404);
    expect(next).not.toHaveBeenCalled();
  });

  it('403s on a non-writable customer even for editors', async () => {
    const { res: r, next } = await run(
      requireProjectRole(['owner', 'editor']),
      reqFor('editor', { customerStatus: 'suspended' }),
    );
    expect(r.status).toHaveBeenCalledWith(403);
    expect(r.json).toHaveBeenCalledWith({ error: 'Customer is suspended — writes are disabled' });
    expect(next).not.toHaveBeenCalled();
  });

  it('404s on an unknown project', async () => {
    oneMock.mockResolvedValue(undefined);
    const { res: r, next } = await run(requireProjectRole(['owner', 'editor']), reqFor('owner'));
    expect(r.status).toHaveBeenCalledWith(404);
    expect(next).not.toHaveBeenCalled();
  });

  it('lets platform admins through without a membership', async () => {
    const { next } = await run(
      requireProjectRole(['owner', 'editor']),
      reqFor(null, { platformAdmin: true }),
    );
    expect(next).toHaveBeenCalled();
  });

  it.each([
    ['projectParam', { id: 'p1' }, undefined, 'FROM projects WHERE id'],
    ['toolParam', { toolId: 't1' }, undefined, 'FROM canonical_tools t JOIN projects'],
    ['reviewItemParam', { itemId: 'ri1' }, undefined, 'FROM review_items ri JOIN projects'],
    ['releaseParam', { releaseId: 'r1' }, undefined, 'FROM releases r JOIN projects'],
    ['bodyProjectId', {}, { project_id: 'p1' }, 'FROM projects WHERE id'],
  ])('resolves the project for source %s', async (source, params, body, sqlFrag) => {
    const { next } = await run(
      requireProjectRole(['owner', 'editor'], source as any),
      reqFor('owner', { params, body }),
    );
    expect(next).toHaveBeenCalled();
    expect(oneMock).toHaveBeenCalledWith(expect.stringContaining(sqlFrag), expect.any(Array));
  });

  it('404s for bodyProjectId when no project_id is given', async () => {
    const { res: r, next } = await run(
      requireProjectRole(['owner', 'editor'], 'bodyProjectId'),
      reqFor('owner', { params: {}, body: {} }),
    );
    expect(r.status).toHaveBeenCalledWith(404);
    expect(next).not.toHaveBeenCalled();
  });
});

describe('requireProjectRead (BE-09 tenant-scoped reads)', () => {
  const project = { id: 'p1', customer_id: 'c1' };
  const run = (mw: any, req: any) => {
    const resObj = res();
    const next = vi.fn();
    return mw(req, resObj, next).then(() => ({ res: resObj, next }));
  };
  const reqFor = (role: Membership['role'] | null, opts: any = {}): any => ({
    params: opts.params ?? { id: 'p1' },
    body: opts.body,
    auth: authCtx({
      isPlatformAdmin: opts.platformAdmin ?? false,
      memberships: role
        ? [member({ role, customerId: opts.customerId ?? 'c1', customerStatus: opts.customerStatus ?? 'active' })]
        : [],
    }),
  });

  beforeEach(() => {
    oneMock.mockResolvedValue(project);
  });

  it.each(['owner', 'editor', 'viewer'] as const)('lets a %s member read', async (role) => {
    const req: any = reqFor(role);
    const { next } = await run(requireProjectRead(), req);
    expect(next).toHaveBeenCalled();
    expect(req.project).toEqual(project);
    expect(req.customer?.role).toBe(role);
  });

  it('404s an outsider with the same answer as an unknown project (no existence leak)', async () => {
    const { res: r, next } = await run(requireProjectRead(), reqFor('owner', { customerId: 'c-other' }));
    expect(r.status).toHaveBeenCalledWith(404);
    expect(r.json).toHaveBeenCalledWith({ error: 'Project not found' });
    expect(next).not.toHaveBeenCalled();
  });

  it('404s an unknown project', async () => {
    oneMock.mockResolvedValue(undefined);
    const { res: r, next } = await run(requireProjectRead(), reqFor('owner'));
    expect(r.status).toHaveBeenCalledWith(404);
    expect(next).not.toHaveBeenCalled();
  });

  it.each(['restricted', 'trial_expired', 'past_due', 'suspended'])(
    'lets a member read while the customer is %s (no writable gate on reads)',
    async (customerStatus) => {
      const { next } = await run(requireProjectRead(), reqFor('viewer', { customerStatus }));
      expect(next).toHaveBeenCalled();
    },
  );

  it('lets platform admins read without a membership', async () => {
    const req: any = reqFor(null, { platformAdmin: true });
    const { next } = await run(requireProjectRead(), req);
    expect(next).toHaveBeenCalled();
    expect(req.customer).toMatchObject({ customerId: 'c1', role: 'owner' });
  });

  it('404s a project with no owning customer for a non-admin caller', async () => {
    oneMock.mockResolvedValue({ id: 'p1', customer_id: null });
    const { next, res } = await run(requireProjectRead(), reqFor(null));
    expect(res.status).toHaveBeenCalledWith(404);
    expect(next).not.toHaveBeenCalled();
  });

  it.each([
    ['releaseParam', { releaseId: 'r1' }, 'FROM releases r JOIN projects', 'Release not found'],
    ['evalRunParam', { runId: 'run1' }, 'FROM eval_runs er JOIN projects', 'Eval run not found'],
  ])('resolves + scopes source %s', async (source, params, sqlFrag, label) => {
    const { next } = await run(requireProjectRead(source as any), reqFor('viewer', { params }));
    expect(next).toHaveBeenCalled();
    expect(oneMock).toHaveBeenCalledWith(expect.stringContaining(sqlFrag), expect.any(Array));

    const denied = await run(requireProjectRead(source as any), reqFor('owner', { params, customerId: 'c-other' }));
    expect(denied.res.status).toHaveBeenCalledWith(404);
    expect(denied.res.json).toHaveBeenCalledWith({ error: label });
    expect(denied.next).not.toHaveBeenCalled();
  });
});
