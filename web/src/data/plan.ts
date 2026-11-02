import type { Me, Usage, WorkspaceMembership } from './api';

// ─── FE-03: the workspace's plan, visible everywhere limits apply ─────────────
// Server-side enforcement already exists (TE-02 retention clamps, BE-11/BE-13
// project caps, FE-08 seat meter); this file is the console's read model so the
// UI renders the designed locked/blocked states instead of crashing into them.
// Growth and Scale are early access, not purchasable yet (D-33) — every nudge
// points at the support inbox, never a checkout button.

export interface WorkspacePlan {
  customerId: string;
  customerName: string;
  planId: string;
  planName: string;
  projectCap: number;
  retentionDays: number;
  trialEndsAt: string | null;
  customerStatus: string;
}

/** D-33: Growth and Scale are early access, not purchasable, until the first
 *  free customer lands. Upgrade nudges never pretend a buy button exists. */
export const UPGRADE_NUDGE =
  'Growth and Scale are early access, not purchasable yet — email hello@connectorfoundry.com about early access.';

export function planForMembership(m: WorkspaceMembership): WorkspacePlan {
  return {
    customerId: m.customer_id,
    customerName: m.customer_name,
    planId: m.plan_id,
    planName: m.plan_name,
    projectCap: m.project_cap,
    retentionDays: Number.isFinite(m.telemetry_retention_days) ? m.telemetry_retention_days : 90,
    trialEndsAt: m.trial_ends_at,
    customerStatus: m.customer_status,
  };
}

/** The workspace the console renders limits for: the first active writable
 *  membership, else the first active one, else null. */
export function planForMe(me: Me | null): WorkspacePlan | null {
  if (!me) return null;
  const active = me.memberships.filter((m) => m.membership_status === 'active');
  const chosen = active.find((m) => m.writable) ?? active[0] ?? null;
  return chosen ? planForMembership(chosen) : null;
}

/** FE-03 AC: over-limit project creation blocks with an upgrade nudge.
 *  Copy names the plan, the cap, and the early-access path (never a raw
 *  "Project limit reached" with no next step). */
export function projectCapMessage(plan: WorkspacePlan, usage: Usage | null): string {
  const used = usage?.projects_used;
  const ofCap = plan.projectCap;
  const count = used === undefined || used === null ? '' : ` (${used}/${ofCap})`;
  return (
    `Project limit reached${count} — your ${plan.planName} plan includes ${ofCap} projects. ` +
    UPGRADE_NUDGE
  );
}

/** The "N of M projects" meter shown under the workspace picker. */
export function projectMeter(usage: Usage | null): string | null {
  if (!usage) return null;
  return `${usage.projects_used} of ${usage.project_cap} projects`;
}
