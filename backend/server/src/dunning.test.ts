import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./db.js', () => ({
  one: vi.fn(),
  q: vi.fn(),
  exec: vi.fn(),
  uid: () => 'uid-1',
}));

import { exec } from './db.js';
import { dunningEscalation, dunningThresholds, sweepDunning, type DunningTarget } from './dunning.js';

const execMock = vi.mocked(exec);

const SINCE = '2026-09-01T00:00:00.000Z';
const daysAfter = (d: number) => new Date(new Date(SINCE).getTime() + d * 86_400_000);
const TH = { restrictDays: 7, suspendDays: 14 };

beforeEach(() => {
  vi.clearAllMocks();
  execMock.mockResolvedValue(1);
  delete process.env.CF_DUNNING_RESTRICT_DAYS;
  delete process.env.CF_DUNNING_SUSPEND_DAYS;
});

describe('dunningThresholds', () => {
  it('defaults to restrict at 7 days, suspend at 14', () => {
    expect(dunningThresholds()).toEqual({ restrictDays: 7, suspendDays: 14 });
  });

  it('honours env overrides and ignores junk values', () => {
    process.env.CF_DUNNING_RESTRICT_DAYS = '3';
    process.env.CF_DUNNING_SUSPEND_DAYS = 'not-a-number';
    expect(dunningThresholds()).toEqual({ restrictDays: 3, suspendDays: 14 });
  });
});

describe('dunningEscalation (BL-04 state machine)', () => {
  it('past_due inside the grace window stays past_due', () => {
    expect(dunningEscalation('past_due', SINCE, daysAfter(6.9), TH)).toBeNull();
  });

  it('past_due at the restrict threshold becomes restricted (read-only)', () => {
    expect(dunningEscalation('past_due', SINCE, daysAfter(7), TH)).toBe('restricted');
  });

  it('restricted inside the suspend window stays restricted', () => {
    expect(dunningEscalation('restricted', SINCE, daysAfter(13), TH)).toBeNull();
  });

  it('restricted at the suspend threshold becomes suspended', () => {
    expect(dunningEscalation('restricted', SINCE, daysAfter(14), TH)).toBe('suspended');
  });

  it('a long-unpaid past_due customer jumps straight to suspended', () => {
    expect(dunningEscalation('past_due', SINCE, daysAfter(30), TH)).toBe('suspended');
  });

  it.each(['active', 'trialing', 'trial_expired', 'suspended'])(
    'never escalates a %s customer',
    (status) => {
      expect(dunningEscalation(status, SINCE, daysAfter(90), TH)).toBeNull();
    },
  );

  it('does nothing without a past_due_since clock (or with a bad one)', () => {
    expect(dunningEscalation('past_due', null, daysAfter(90), TH)).toBeNull();
    expect(dunningEscalation('past_due', 'not-a-date', daysAfter(90), TH)).toBeNull();
  });

  it('respects custom thresholds', () => {
    const custom = { restrictDays: 1, suspendDays: 2 };
    expect(dunningEscalation('past_due', SINCE, daysAfter(1.5), custom)).toBe('restricted');
    expect(dunningEscalation('past_due', SINCE, daysAfter(2), custom)).toBe('suspended');
  });
});

describe('sweepDunning', () => {
  const target = (over: Partial<DunningTarget> = {}): DunningTarget => ({
    customerId: 'c1', customerStatus: 'past_due', pastDueSince: SINCE, ...over,
  });

  it('persists the escalation and mutates the target in place', async () => {
    const t = target();
    await sweepDunning([t], daysAfter(8), TH);
    expect(t.customerStatus).toBe('restricted');
    expect(execMock).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE customers SET status'),
      ['restricted', 'c1'],
    );
  });

  it('leaves customers inside their window untouched (no DB write)', async () => {
    const t = target();
    await sweepDunning([t], daysAfter(2), TH);
    expect(t.customerStatus).toBe('past_due');
    expect(execMock).not.toHaveBeenCalled();
  });

  it('sweeps each target independently', async () => {
    const due = target({ customerId: 'c-due' });
    const fine = target({ customerId: 'c-fine', customerStatus: 'active', pastDueSince: null });
    const dead = target({ customerId: 'c-dead' });
    await sweepDunning([due, fine, dead], daysAfter(20), TH);
    expect(due.customerStatus).toBe('suspended');
    expect(fine.customerStatus).toBe('active');
    expect(dead.customerStatus).toBe('suspended');
    expect(execMock).toHaveBeenCalledTimes(2);
  });
});
