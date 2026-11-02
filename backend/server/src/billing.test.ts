import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./db.js', () => ({
  one: vi.fn(),
  q: vi.fn(),
  exec: vi.fn(),
  uid: () => 'uid-1',
}));

import { one, exec } from './db.js';
import { applyWebhookEvent } from './billing.js';

const oneMock = vi.mocked(one);
const execMock = vi.mocked(exec);

/** All UPDATE-customers statements issued so far, as SQL strings. */
const customerUpdates = () =>
  execMock.mock.calls.map(([sql]) => String(sql)).filter((s) => s.includes('UPDATE customers'));

const evt = (type: string, object: any, id = `evt_${type}`): any => ({ id, type, data: { object } });

beforeEach(() => {
  vi.clearAllMocks();
  // claimEvent: INSERT returns 1 (fresh event) unless a test says otherwise.
  execMock.mockResolvedValue(1);
  oneMock.mockResolvedValue(undefined);
});

describe('applyWebhookEvent — BL-04 dunning', () => {
  it('invoice.payment_failed moves the customer into the past_due reminder stage and starts the clock', async () => {
    oneMock.mockResolvedValue({ id: 'c1' }); // stripe_customer_id → foundry customer
    const summary = await applyWebhookEvent(evt('invoice.payment_failed', { customer: 'cus_1' }));
    expect(summary).toContain('past_due');
    const updates = customerUpdates();
    expect(updates).toHaveLength(1);
    expect(updates[0]).toContain("status = 'active' THEN 'past_due'");
    expect(updates[0]).toContain('past_due_since');
    expect(updates[0]).toContain('COALESCE(past_due_since, now())');
    expect(updates[0]).toContain('payment_failed_count = payment_failed_count + 1');
    expect(execMock.mock.calls.find(([s]) => String(s).includes('UPDATE customers'))![1]).toEqual(['c1']);
  });

  it('invoice.payment_failed for an unknown Stripe customer changes nothing', async () => {
    oneMock.mockResolvedValue(undefined);
    const summary = await applyWebhookEvent(evt('invoice.payment_failed', { customer: 'cus_who' }));
    expect(summary).toContain('ignored');
    expect(customerUpdates()).toHaveLength(0);
  });

  it('a redelivered payment_failed event is a no-op (duplicate guard)', async () => {
    oneMock.mockResolvedValue({ id: 'c1' });
    execMock.mockResolvedValue(0); // billing_events INSERT conflicted → already processed
    const summary = await applyWebhookEvent(evt('invoice.payment_failed', { customer: 'cus_1' }));
    expect(summary).toContain('duplicate');
    expect(customerUpdates()).toHaveLength(0);
  });

  it.each(['invoice.payment_succeeded', 'invoice.paid'])(
    '%s clears dunning and restores active for past_due/restricted customers',
    async (type) => {
      oneMock.mockResolvedValue({ id: 'c1' });
      const summary = await applyWebhookEvent(evt(type, { customer: 'cus_1' }));
      expect(summary).toContain('payment succeeded');
      const updates = customerUpdates();
      expect(updates).toHaveLength(1);
      expect(updates[0]).toContain("status IN ('past_due', 'restricted') THEN 'active'");
      expect(updates[0]).toContain('past_due_since');
    },
  );

  it('subscription past_due starts dunning for an active customer only', async () => {
    const summary = await applyWebhookEvent(evt('customer.subscription.updated', {
      id: 'sub_1', status: 'past_due', metadata: { foundry_customer_id: 'c1' }, items: { data: [] },
    }));
    expect(summary).toContain('past_due');
    const updates = customerUpdates();
    expect(updates).toHaveLength(1);
    expect(updates[0]).toContain("SET status = 'past_due'");
    expect(updates[0]).toContain("status = 'active'");
  });

  it('subscription unpaid restricts the customer (read-only stage)', async () => {
    const summary = await applyWebhookEvent(evt('customer.subscription.updated', {
      id: 'sub_1', status: 'unpaid', metadata: { foundry_customer_id: 'c1' }, items: { data: [] },
    }));
    expect(summary).toContain('restricted');
    expect(customerUpdates()[0]).toContain("SET status = 'restricted'");
  });

  it('subscription active on a mapped plan reactivates and clears the dunning clock', async () => {
    oneMock.mockImplementation(async (sql: string) =>
      sql.includes('stripe_price_id') ? { id: 'starter' } : undefined);
    const summary = await applyWebhookEvent(evt('customer.subscription.updated', {
      id: 'sub_1', status: 'active', metadata: { foundry_customer_id: 'c1' },
      items: { data: [{ price: { id: 'price_1' } }] },
    }));
    expect(summary).toContain('moved to plan starter');
    const updates = customerUpdates();
    expect(updates).toHaveLength(1);
    expect(updates[0]).toContain('past_due_since = NULL');
    expect(updates[0]).toContain('payment_failed_count = 0');
  });

  it('checkout.session.completed activates and clears any dunning state', async () => {
    const summary = await applyWebhookEvent(evt('checkout.session.completed', {
      metadata: { foundry_customer_id: 'c1', foundry_plan_id: 'growth' },
      customer: 'cus_1', subscription: 'sub_1',
    }));
    expect(summary).toContain('activated on plan growth');
    const updates = customerUpdates();
    expect(updates).toHaveLength(1);
    expect(updates[0]).toContain('past_due_since = NULL');
  });

  it('subscription deleted still suspends (and drops the dunning clock)', async () => {
    const summary = await applyWebhookEvent(evt('customer.subscription.deleted', {
      id: 'sub_1', status: 'canceled', metadata: { foundry_customer_id: 'c1' }, items: { data: [] },
    }));
    expect(summary).toContain('suspended');
    expect(customerUpdates()[0]).toContain("status = 'suspended'");
    expect(customerUpdates()[0]).toContain('past_due_since = NULL');
  });
});
