// Dunning (BL-04): the automated unpaid-account state machine.
//
//   active ──invoice.payment_failed──▶ past_due ──7d unpaid──▶ restricted ──14d unpaid──▶ suspended
//                                        │  (reminder stage,     (read-only)         (terminal here;
//                                        │   still writable)                        admin/payment
//                                        └──── payment succeeds ────▶ active ◀──────┘  can revive)
//
// Entry into past_due happens in the Stripe webhook (billing.ts); the
// time-based escalation happens here, as a lazy sweep on auth load — the
// same pattern as the trial-expiry sweep in auth.ts, so no scheduler or
// cron dependency is needed for v1: the next request after a threshold
// flips the customer, and `customerWritable` makes `restricted` read-only.
//
// Thresholds are env-tunable (days since `past_due_since`):
//   CF_DUNNING_RESTRICT_DAYS (default 7), CF_DUNNING_SUSPEND_DAYS (default 14).
// A customer whose requests stop entirely still escalates on their next
// request — and Stripe's own retry/cancel flow (subscription.deleted →
// suspended in billing.ts) bounds how long an abandoned workspace lingers.

import { exec } from './db.js';

export interface DunningThresholds {
  restrictDays: number;
  suspendDays: number;
}

function daysFromEnv(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Read thresholds fresh each call so deploys/tests can retune via env. */
export function dunningThresholds(): DunningThresholds {
  return {
    restrictDays: daysFromEnv('CF_DUNNING_RESTRICT_DAYS', 7),
    suspendDays: daysFromEnv('CF_DUNNING_SUSPEND_DAYS', 14),
  };
}

export type DunningEscalation = 'restricted' | 'suspended';

/**
 * Pure stage computation: given a customer's status and when it went
 * past due, what (if anything) should it escalate to at `now`?
 * Returns null when no transition is due. A long-unpaid past_due customer
 * jumps straight to suspended (skips restricted) — the stages are floors,
 * not a queue the customer must pass through one request at a time.
 */
export function dunningEscalation(
  status: string,
  pastDueSince: string | Date | null | undefined,
  now: Date = new Date(),
  thresholds: DunningThresholds = dunningThresholds(),
): DunningEscalation | null {
  if (status !== 'past_due' && status !== 'restricted') return null;
  if (!pastDueSince) return null;
  const since = pastDueSince instanceof Date ? pastDueSince : new Date(pastDueSince);
  if (Number.isNaN(since.getTime())) return null;
  const ageDays = (now.getTime() - since.getTime()) / 86_400_000;
  if (ageDays >= thresholds.suspendDays) return 'suspended';
  if (status === 'past_due' && ageDays >= thresholds.restrictDays) return 'restricted';
  return null;
}

export interface DunningTarget {
  customerId: string;
  customerStatus: string;
  pastDueSince: string | null;
}

/**
 * Lazy sweep, mirroring sweepExpiredTrials: mutate each target in place
 * (so the in-flight request already sees the new status) and persist the
 * transition. The subscription id is kept on dunning-suspension — unlike
 * a cancellation, paying the overdue invoice must be able to revive the
 * workspace (billing.ts restores past_due/restricted on payment success).
 */
export async function sweepDunning(
  targets: DunningTarget[],
  now: Date = new Date(),
  thresholds: DunningThresholds = dunningThresholds(),
): Promise<void> {
  for (const t of targets) {
    const next = dunningEscalation(t.customerStatus, t.pastDueSince, now, thresholds);
    if (!next) continue;
    await exec(`UPDATE customers SET status = $1, updated_at = now() WHERE id = $2`, [next, t.customerId]);
    t.customerStatus = next;
  }
}
