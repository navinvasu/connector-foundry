import { describe, expect, it } from 'vitest';
import {
  UPGRADE_NUDGE,
  planForMe,
  planForMembership,
  projectCapMessage,
  projectMeter,
  type WorkspacePlan,
} from './plan';
import type { Me, Usage, WorkspaceMembership } from './api';

const trialMembership = (over: Partial<WorkspaceMembership> = {}): WorkspaceMembership => ({
  customer_id: 'c-9',
  customer_name: 'Acme',
  customer_status: 'trialing',
  plan_id: 'trial',
  plan_name: 'Trial',
  role: 'owner',
  membership_status: 'active',
  writable: true,
  project_cap: 2,
  telemetry_retention_days: 30,
  trial_ends_at: null,
  ...over,
});

const me = (memberships: WorkspaceMembership[]): Me => ({
  user: { id: 'u-1', email: 'n@acme.test', full_name: 'N', is_platform_admin: false },
  memberships,
});

describe('planForMembership (FE-03)', () => {
  it('maps the trial plan to its real retention and project cap', () => {
    const p = planForMembership(trialMembership());
    expect(p).toMatchObject({
      customerId: 'c-9',
      planId: 'trial',
      planName: 'Trial',
      projectCap: 2,
      retentionDays: 30,
    });
  });

  it('maps a Starter membership to 90-day retention', () => {
    const p = planForMembership(
      trialMembership({ plan_id: 'starter', plan_name: 'Starter', project_cap: 5, telemetry_retention_days: 90 }),
    );
    expect(p).toMatchObject({ projectCap: 5, retentionDays: 90 });
  });

  it('falls back to 90 days when the server sends a non-finite retention', () => {
    const p = planForMembership(trialMembership({ telemetry_retention_days: NaN as any }));
    expect(p.retentionDays).toBe(90);
  });
});

describe('planForMe (FE-03)', () => {
  it('is null when identity is unloaded', () => {
    expect(planForMe(null)).toBeNull();
  });

  it('prefers the active writable membership', () => {
    const p = planForMe(
      me([
        trialMembership({ plan_id: 'starter', plan_name: 'Starter', telemetry_retention_days: 90, writable: false, role: 'viewer' }),
        trialMembership(),
      ]),
    );
    expect(p?.planId).toBe('trial');
    expect(p?.retentionDays).toBe(30);
  });

  it('falls back to a non-writable active membership rather than null', () => {
    const p = planForMe(me([trialMembership({ writable: false, role: 'viewer' })]));
    expect(p?.planName).toBe('Trial');
  });

  it('is null when every membership is inactive', () => {
    expect(planForMe(me([trialMembership({ membership_status: 'invited' })]))).toBeNull();
  });
});

const usage = (used: number, cap: number): Usage => ({
  seats_used: 1,
  seat_cap: 3,
  seat_override: null,
  plan_seat_cap: 3,
  projects_used: used,
  project_cap: cap,
});

describe('projectCapMessage (FE-03)', () => {
  const starter: WorkspacePlan = {
    customerId: 'c1', customerName: 'Acme', planId: 'starter', planName: 'Starter',
    projectCap: 5, retentionDays: 90, trialEndsAt: null, customerStatus: 'active',
  };

  it('names the plan, the usage, and the cap', () => {
    const msg = projectCapMessage(starter, usage(5, 5));
    expect(msg).toContain('Project limit reached (5/5)');
    expect(msg).toContain('Starter');
    expect(msg).toContain('5 projects');
  });

  it('never pretends a buy button exists — Growth/Scale are early access (D-33)', () => {
    const msg = projectCapMessage(starter, usage(5, 5));
    expect(msg).toContain(UPGRADE_NUDGE);
    expect(UPGRADE_NUDGE).toMatch(/early access/);
    expect(msg.toLowerCase()).not.toContain('checkout');
  });

  it('works without usage (server details may be the only source)', () => {
    const msg = projectCapMessage(starter, null);
    expect(msg).toContain('Project limit reached');
    expect(msg).toContain('5 projects');
  });
});

describe('projectMeter (FE-03)', () => {
  it('renders "N of M projects"', () => {
    expect(projectMeter(usage(2, 5))).toBe('2 of 5 projects');
  });

  it('is null without usage', () => {
    expect(projectMeter(null)).toBeNull();
  });
});
