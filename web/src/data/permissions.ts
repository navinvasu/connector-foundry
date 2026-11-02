// FE-09: role-gated UI. The console must never offer an action the API
// will refuse — viewers browse read-only, editors build and publish,
// owners additionally manage team, billing, and project deletion. This
// module is the pure, tested core: it derives what the signed-in user may
// do in a workspace from /v1/me, mirroring the backend BE-13 matrix
// (requireProjectRole: owner/editor mutate a writable workspace;
// owner-only user management, billing, and SE-04 project deletion;
// platform admins bypass with an owner-shaped membership).
//
// The API stays the real gate — this is convenience, not security. Two
// deliberate fail-opens: identity not yet loaded (me === null) and legacy
// projects with no owning customer both read as fully capable, exactly as
// the console behaved before FE-09. A *known* viewer, a non-writable workspace, or
// a non-member is restricted with a plain-language reason.

import type { Me } from './api';

export type WorkspaceRole = 'owner' | 'editor' | 'viewer';

export interface WorkspaceAccess {
  /** The caller's role in this workspace; 'platform_admin' for the bypass. */
  role: WorkspaceRole | 'platform_admin' | null;
  /** Project mutations: import, compile, tool approve/edit, review, eval, release, invoke. */
  canEdit: boolean;
  /** Owner-only: invite, role changes, member removal. */
  canManageTeam: boolean;
  /** Owner-only: checkout, portal, plan changes. */
  canManageBilling: boolean;
  /** Owner-only (SE-04): delete a project. */
  canDeleteProject: boolean;
  /** Why editing is unavailable; null when canEdit or when access is unknown. */
  readOnlyReason: string | null;
  /** Why team/billing actions are unavailable; null when allowed or unknown. */
  ownerOnlyReason: string | null;
}

const PERMISSIVE: WorkspaceAccess = {
  role: null,
  canEdit: true,
  canManageTeam: true,
  canManageBilling: true,
  canDeleteProject: true,
  readOnlyReason: null,
  ownerOnlyReason: null,
};

function statusLabel(status: string): string {
  return status.replace(/_/g, ' ');
}

/**
 * What `me` may do in the workspace `customerId` (a project's owning
 * customer). Omit customerId for legacy projects with no owner.
 */
export function accessForWorkspace(me: Me | null, customerId?: string | null): WorkspaceAccess {
  if (!me) return PERMISSIVE;
  // Legacy projects carry no owning customer; the backend treats them as
  // admin-only and remains the gate.
  if (!customerId) {
    return me.user.is_platform_admin ? { ...PERMISSIVE, role: 'platform_admin' } : PERMISSIVE;
  }
  const membership = me.memberships.find(
    (m) => m.customer_id === customerId && m.membership_status === 'active',
  );
  if (!membership) {
    if (me.user.is_platform_admin) return { ...PERMISSIVE, role: 'platform_admin' };
    const reason = 'You are not an active member of this workspace, so it is read-only for you.';
    return {
      role: null, canEdit: false, canManageTeam: false, canManageBilling: false,
      canDeleteProject: false, readOnlyReason: reason, ownerOnlyReason: reason,
    };
  }
  const role = membership.role;
  if (!membership.writable) {
    const reason =
      `This workspace is ${statusLabel(membership.customer_status)} and read-only right now — ` +
      'you can browse everything, but changes are paused.';
    return {
      role, canEdit: false, canManageTeam: false, canManageBilling: false,
      canDeleteProject: false, readOnlyReason: reason, ownerOnlyReason: reason,
    };
  }
  if (role === 'viewer') {
    const reason =
      'You are a viewer in this workspace — you can browse everything, ' +
      'but only owners and editors can make changes.';
    return {
      role, canEdit: false, canManageTeam: false, canManageBilling: false,
      canDeleteProject: false, readOnlyReason: reason, ownerOnlyReason: reason,
    };
  }
  if (role === 'editor') {
    return {
      role, canEdit: true, canManageTeam: false, canManageBilling: false,
      canDeleteProject: false, readOnlyReason: null,
      ownerOnlyReason: 'Only workspace owners can manage team members and billing.',
    };
  }
  return {
    role, canEdit: true, canManageTeam: true, canManageBilling: true,
    canDeleteProject: true, readOnlyReason: null, ownerOnlyReason: null,
  };
}

/** Project-shaped convenience wrapper (ProjectSummary.customerId). */
export function accessForProject(
  me: Me | null,
  project?: { customerId?: string | null } | null,
): WorkspaceAccess {
  return accessForWorkspace(me, project?.customerId);
}

/**
 * Creating a project takes an owner/editor seat in at least one writable
 * workspace (the wizard picks the workspace). Platform admins and an
 * unloaded identity keep the button; the API enforces the rest.
 */
export function canCreateProject(me: Me | null): boolean {
  if (!me || me.user.is_platform_admin) return true;
  return me.memberships.some(
    (m) => m.membership_status === 'active' && m.writable && m.role !== 'viewer',
  );
}
