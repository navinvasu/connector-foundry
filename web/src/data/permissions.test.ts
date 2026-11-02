import { describe, it, expect } from 'vitest';
import { accessForWorkspace, accessForProject, canCreateProject } from './permissions';
import type { Me, WorkspaceMembership } from './api';

const membership = (over: Partial<WorkspaceMembership> = {}): WorkspaceMembership => ({
  customer_id: 'c-1', customer_name: 'Acme', customer_status: 'active', plan_id: 'starter',
  plan_name: 'Starter', role: 'owner', membership_status: 'active', writable: true,
  project_cap: 5, telemetry_retention_days: 90, trial_ends_at: null, ...over,
});

const me = (over: Partial<Me> = {}): Me => ({
  user: { id: 'u-1', email: 'n@acme.test', full_name: 'N', is_platform_admin: false },
  memberships: [membership()],
  ...over,
});

describe('accessForWorkspace (FE-09)', () => {
  it('fails open while identity is unloaded — the API is the gate', () => {
    const a = accessForWorkspace(null, 'c-1');
    expect(a).toMatchObject({ canEdit: true, canManageTeam: true, readOnlyReason: null });
  });

  it('fails open for demo/legacy projects with no owning customer', () => {
    expect(accessForWorkspace(me(), null).canEdit).toBe(true);
    expect(accessForWorkspace(me(), undefined).canEdit).toBe(true);
    expect(accessForProject(me(), { customerId: undefined }).canEdit).toBe(true);
  });

  it('owners can edit, manage team and billing, and delete projects', () => {
    const a = accessForWorkspace(me(), 'c-1');
    expect(a).toMatchObject({
      role: 'owner', canEdit: true, canManageTeam: true,
      canManageBilling: true, canDeleteProject: true, readOnlyReason: null, ownerOnlyReason: null,
    });
  });

  it('editors can edit but hit the owner-only wall for team and billing', () => {
    const a = accessForWorkspace(me({ memberships: [membership({ role: 'editor' })] }), 'c-1');
    expect(a.canEdit).toBe(true);
    expect(a.canManageTeam).toBe(false);
    expect(a.canManageBilling).toBe(false);
    expect(a.canDeleteProject).toBe(false);
    expect(a.readOnlyReason).toBeNull();
    expect(a.ownerOnlyReason).toMatch(/Only workspace owners/);
  });

  it('viewers are read-only with a plain-language reason', () => {
    const a = accessForWorkspace(me({ memberships: [membership({ role: 'viewer' })] }), 'c-1');
    expect(a).toMatchObject({ role: 'viewer', canEdit: false, canManageTeam: false });
    expect(a.readOnlyReason).toMatch(/viewer in this workspace/);
    expect(a.ownerOnlyReason).toBe(a.readOnlyReason);
  });

  it('a non-writable workspace is read-only even for its owner', () => {
    const a = accessForWorkspace(
      me({ memberships: [membership({ writable: false, customer_status: 'trial_expired' })] }),
      'c-1',
    );
    expect(a.canEdit).toBe(false);
    expect(a.canManageTeam).toBe(false);
    expect(a.readOnlyReason).toMatch(/trial expired and read-only/);
  });

  it('non-members get read-only, never another workspace\u2019s role', () => {
    const a = accessForWorkspace(me(), 'c-other');
    expect(a).toMatchObject({ role: null, canEdit: false, canManageTeam: false });
    expect(a.readOnlyReason).toMatch(/not an active member/);
  });

  it('invited (not yet active) memberships do not grant edit rights', () => {
    const a = accessForWorkspace(
      me({ memberships: [membership({ membership_status: 'invited' })] }),
      'c-1',
    );
    expect(a.canEdit).toBe(false);
  });

  it('platform admins bypass via the owner-shaped membership', () => {
    const a = accessForWorkspace(
      me({
        user: { id: 'a-1', email: 'op@foundry.test', full_name: null, is_platform_admin: true },
        memberships: [],
      }),
      'c-1',
    );
    expect(a).toMatchObject({ role: 'platform_admin', canEdit: true, canManageTeam: true });
  });

  it('picks the membership for the project\u2019s customer, not the first one', () => {
    const a = accessForWorkspace(
      me({
        memberships: [
          membership({ customer_id: 'c-1', role: 'viewer' }),
          membership({ customer_id: 'c-2', role: 'editor' }),
        ],
      }),
      'c-2',
    );
    expect(a).toMatchObject({ role: 'editor', canEdit: true });
  });
});

describe('canCreateProject (FE-09)', () => {
  it('is true for owners/editors of a writable workspace, admins, and unloaded identity', () => {
    expect(canCreateProject(me())).toBe(true);
    expect(canCreateProject(me({ memberships: [membership({ role: 'editor' })] }))).toBe(true);
    expect(canCreateProject(null)).toBe(true);
    expect(canCreateProject(me({
      user: { id: 'a-1', email: 'op@foundry.test', full_name: null, is_platform_admin: true },
      memberships: [],
    }))).toBe(true);
  });

  it('is false for viewer-only users and members of read-only workspaces', () => {
    expect(canCreateProject(me({ memberships: [membership({ role: 'viewer' })] }))).toBe(false);
    expect(canCreateProject(me({ memberships: [membership({ writable: false })] }))).toBe(false);
    expect(canCreateProject(me({ memberships: [] }))).toBe(false);
  });
});
