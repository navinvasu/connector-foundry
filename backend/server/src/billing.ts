// Trial → paid billing via Stripe.
//
// The money flow:
//   1. Owner clicks Upgrade in the console → POST /v1/customers/:id/billing/checkout
//   2. Server creates a Stripe Checkout Session (subscription mode) and returns
//      the Stripe-hosted URL; the console redirects there. Stripe collects the
//      card — card details never touch our servers.
//   3. Stripe fires `checkout.session.completed` at POST /v1/billing/webhook,
//      verified by signature. We flip the customer to `active` on the paid plan
//      and record the Stripe customer + subscription ids.
//   4. Plan changes / cancellation are self-serve through the Stripe Customer
//      Portal (POST /v1/customers/:id/billing/portal). `customer.subscription.*`
//      webhooks keep our plan in sync.
//
// Setup (Naveen, one time, Stripe test mode first):
//   - Create Products + recurring Prices for starter/growth/scale in the
//     Stripe dashboard, then backfill:
//       UPDATE plans SET stripe_price_id = 'price_...', price_display = '$29/mo'
//       WHERE id = 'starter';
//   - Set STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET (see .env.example).
//   - Local webhook testing: `stripe listen --forward-to localhost:4000/v1/billing/webhook`

import Stripe from 'stripe';
import { one, q, exec } from './db.js';

const SECRET = process.env.STRIPE_SECRET_KEY ?? '';
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET ?? '';

let client: Stripe | null = null;
export function stripe(): Stripe | null {
  if (!SECRET) return null;
  if (!client) client = new Stripe(SECRET, { apiVersion: '2026-08-26.dahlia' });
  return client;
}

export function billingEnabled(): boolean {
  return SECRET.length > 0;
}

/** Reuse the Stripe customer across checkouts; create on first purchase. */
export async function getOrCreateStripeCustomer(
  s: Stripe,
  customerId: string,
  email: string,
): Promise<string> {
  const row = await one<any>(`SELECT stripe_customer_id FROM customers WHERE id = $1`, [customerId]);
  if (row?.stripe_customer_id) return row.stripe_customer_id as string;
  const sc = await s.customers.create({
    email,
    metadata: { foundry_customer_id: customerId },
  });
  await exec(
    `UPDATE customers SET stripe_customer_id = $1, billing_email = $2, updated_at = now() WHERE id = $3`,
    [sc.id, email, customerId],
  );
  return sc.id;
}

export interface CheckoutArgs {
  customerId: string;
  customerName: string;
  planId: string;
  email: string;
  /** Days of free trial left. The card is added now; Stripe bills when it hits 0. */
  trialDaysLeft: number;
  successUrl: string;
  cancelUrl: string;
}

/** Build a subscription Checkout Session for a plan. Throws when misconfigured. */
export async function createCheckoutSession(s: Stripe, a: CheckoutArgs): Promise<string> {
  const plan = await one<any>(`SELECT * FROM plans WHERE id = $1 AND status = 'active'`, [a.planId]);
  if (!plan) throw Object.assign(new Error(`Unknown plan: ${a.planId}`), { status: 400 });
  if (plan.is_trial) throw Object.assign(new Error('The trial plan cannot be purchased'), { status: 400 });
  if (!plan.stripe_price_id) {
    throw Object.assign(
      new Error(`Plan "${plan.name}" has no Stripe price yet — create it in the Stripe dashboard and backfill plans.stripe_price_id`),
      { status: 503 },
    );
  }
  const stripeCustomerId = await getOrCreateStripeCustomer(s, a.customerId, a.email);
  const session = await s.checkout.sessions.create({
    mode: 'subscription',
    customer: stripeCustomerId,
    line_items: [{ price: plan.stripe_price_id as string, quantity: 1 }],
    client_reference_id: a.customerId,
    metadata: { foundry_customer_id: a.customerId, foundry_plan_id: plan.id },
    subscription_data: {
      metadata: { foundry_customer_id: a.customerId, foundry_plan_id: plan.id },
      // Card on file now, first charge when the workspace trial runs out.
      ...(a.trialDaysLeft > 0 ? { trial_period_days: a.trialDaysLeft } : {}),
    },
    success_url: a.successUrl,
    cancel_url: a.cancelUrl,
  });
  if (!session.url) throw new Error('Stripe did not return a checkout URL');
  return session.url;
}

/** Self-serve portal: upgrade, downgrade, cancel, update card. */
export async function createPortalSession(s: Stripe, customerId: string, returnUrl: string): Promise<string> {
  const row = await one<any>(`SELECT stripe_customer_id FROM customers WHERE id = $1`, [customerId]);
  if (!row?.stripe_customer_id) {
    throw Object.assign(new Error('No Stripe customer yet — complete a checkout first'), { status: 400 });
  }
  const ps = await s.billingPortal.sessions.create({
    customer: row.stripe_customer_id as string,
    return_url: returnUrl,
  });
  return ps.url;
}

async function planIdForPrice(priceId: string | null | undefined): Promise<string | null> {
  if (!priceId) return null;
  const row = await one<any>(`SELECT id FROM plans WHERE stripe_price_id = $1`, [priceId]);
  return (row?.id as string) ?? null;
}

function subscriptionPriceId(sub: Stripe.Subscription): string | null {
  const item = sub.items.data[0];
  const price = item?.price;
  return typeof price === 'string' ? price : (price?.id ?? null);
}

/** Mark a Stripe event processed; returns false if already seen (redelivery). */
async function claimEvent(evt: Stripe.Event, customerId: string | null): Promise<boolean> {
  const n = await exec(
    `INSERT INTO billing_events (id, type, customer_id) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
    [evt.id, evt.type, customerId],
  );
  return n === 1;
}

/**
 * Apply a verified Stripe event to our tables. Idempotent — safe to replay.
 * Returns a short human summary for logs.
 */
export async function applyWebhookEvent(evt: Stripe.Event): Promise<string> {
  switch (evt.type) {
    case 'checkout.session.completed': {
      const session = evt.data.object as Stripe.Checkout.Session;
      const customerId =
        session.metadata?.foundry_customer_id ??
        (typeof session.client_reference_id === 'string' ? session.client_reference_id : null);
      if (!customerId) return 'ignored: no foundry_customer_id';
      if (!(await claimEvent(evt, customerId))) return 'duplicate: already processed';

      const planId = session.metadata?.foundry_plan_id ?? 'starter';
      const subscriptionId =
        typeof session.subscription === 'string' ? session.subscription : session.subscription?.id ?? null;
      await exec(
        `UPDATE customers
            SET plan_id = $1, status = 'active',
                stripe_customer_id = COALESCE(stripe_customer_id, $2),
                stripe_subscription_id = COALESCE(stripe_subscription_id, $3),
                trial_ends_at = CASE WHEN status = 'trialing' THEN now() ELSE trial_ends_at END,
                past_due_since = NULL, payment_failed_count = 0, last_payment_failed_at = NULL,
                updated_at = now()
          WHERE id = $4`,
        [planId, typeof session.customer === 'string' ? session.customer : null, subscriptionId, customerId],
      );
      return `customer ${customerId} activated on plan ${planId}`;
    }

    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const sub = evt.data.object as Stripe.Subscription;
      const customerId = sub.metadata?.foundry_customer_id ?? null;
      const foundryId =
        customerId ??
        (await one<any>(`SELECT id FROM customers WHERE stripe_subscription_id = $1`, [sub.id]))?.id ??
        null;
      if (!foundryId) return 'ignored: unknown subscription';
      if (!(await claimEvent(evt, foundryId))) return 'duplicate: already processed';

      if (evt.type === 'customer.subscription.deleted' || sub.status === 'canceled') {
        await exec(
          `UPDATE customers SET status = 'suspended', stripe_subscription_id = NULL, past_due_since = NULL, updated_at = now() WHERE id = $1`,
          [foundryId],
        );
        return `customer ${foundryId} suspended (subscription canceled)`;
      }
      // BL-04: Stripe's own subscription lifecycle feeds the same dunning
      // state machine — past_due starts the clock, unpaid is the read-only
      // stage. Only a live customer escalates; a suspended one stays put.
      if (sub.status === 'past_due') {
        await exec(
          `UPDATE customers
              SET status = 'past_due', past_due_since = COALESCE(past_due_since, now()), updated_at = now()
            WHERE id = $1 AND status = 'active'`,
          [foundryId],
        );
        return `customer ${foundryId} is past_due (subscription past_due)`;
      }
      if (sub.status === 'unpaid') {
        await exec(
          `UPDATE customers
              SET status = 'restricted', past_due_since = COALESCE(past_due_since, now()), updated_at = now()
            WHERE id = $1 AND status IN ('active', 'past_due')`,
          [foundryId],
        );
        return `customer ${foundryId} restricted (subscription unpaid)`;
      }
      const planId = await planIdForPrice(subscriptionPriceId(sub));
      if (planId) {
        await exec(
          `UPDATE customers
              SET plan_id = $1, status = 'active',
                  past_due_since = NULL, payment_failed_count = 0, last_payment_failed_at = NULL,
                  updated_at = now()
            WHERE id = $2`,
          [planId, foundryId],
        );
        return `customer ${foundryId} moved to plan ${planId} (subscription ${sub.status})`;
      }
      return `customer ${foundryId}: subscription ${sub.status}, price not mapped to a plan`;
    }

    case 'invoice.payment_failed': {
      const inv = evt.data.object as Stripe.Invoice;
      const customerId = typeof inv.customer === 'string'
        ? (await one<any>(`SELECT id FROM customers WHERE stripe_customer_id = $1`, [inv.customer]))?.id ?? null
        : null;
      if (!(await claimEvent(evt, customerId))) return 'duplicate: already processed';
      if (!customerId) return 'ignored: payment failed for unknown Stripe customer';
      // BL-04 stage 1 (reminder): an active customer enters past_due and
      // the dunning clock starts. Repeated failures keep the ORIGINAL
      // past_due_since (the clock measures time unpaid, not failure count)
      // and only bump the counter. past_due customers stay writable during
      // the grace window (see dunning.ts); escalation to restricted /
      // suspended is time-based. SET expressions read the pre-update row,
      // so every CASE below keys off the customer's previous status.
      await exec(
        `UPDATE customers
            SET status = CASE WHEN status = 'active' THEN 'past_due' ELSE status END,
                past_due_since = CASE WHEN status IN ('active', 'past_due', 'restricted')
                                       THEN COALESCE(past_due_since, now()) ELSE past_due_since END,
                payment_failed_count = payment_failed_count + 1,
                last_payment_failed_at = now(),
                updated_at = now()
          WHERE id = $1`,
        [customerId],
      );
      return `customer ${customerId} payment failed — past_due (dunning reminder stage)`;
    }

    case 'invoice.payment_succeeded':
    case 'invoice.paid': {
      const inv = evt.data.object as Stripe.Invoice;
      const customerId = typeof inv.customer === 'string'
        ? (await one<any>(`SELECT id FROM customers WHERE stripe_customer_id = $1`, [inv.customer]))?.id ?? null
        : null;
      if (!(await claimEvent(evt, customerId))) return 'duplicate: already processed';
      if (!customerId) return 'ignored: payment succeeded for unknown Stripe customer';
      // BL-04 recovery: paying up before suspension restores full access
      // and resets the dunning clock. A suspended customer is NOT revived
      // here — cancellation/admin suspension needs an explicit path back.
      await exec(
        `UPDATE customers
            SET status = CASE WHEN status IN ('past_due', 'restricted') THEN 'active' ELSE status END,
                past_due_since = CASE WHEN status IN ('past_due', 'restricted') THEN NULL ELSE past_due_since END,
                payment_failed_count = CASE WHEN status IN ('past_due', 'restricted') THEN 0 ELSE payment_failed_count END,
                last_payment_failed_at = CASE WHEN status IN ('past_due', 'restricted') THEN NULL ELSE last_payment_failed_at END,
                updated_at = now()
          WHERE id = $1`,
        [customerId],
      );
      return `customer ${customerId} payment succeeded — dunning cleared if it was past due`;
    }

    default:
      return `ignored: ${evt.type}`;
  }
}

/** Verify the webhook signature and parse the event. Throws 400 on failure. */
export function parseWebhookEvent(rawBody: Buffer, signature: string | undefined): Stripe.Event {
  const s = stripe();
  if (!s) throw Object.assign(new Error('Billing is not configured'), { status: 503 });
  if (!WEBHOOK_SECRET) {
    throw Object.assign(
      new Error('STRIPE_WEBHOOK_SECRET is not set — refusing to accept unverified webhooks'),
      { status: 503 },
    );
  }
  try {
    return s.webhooks.constructEvent(rawBody, signature ?? '', WEBHOOK_SECRET);
  } catch (e: any) {
    throw Object.assign(new Error(`Webhook signature verification failed: ${e.message}`), { status: 400 });
  }
}

export async function purchasablePlans() {
  return q<any>(
    `SELECT id, name, seat_cap, project_cap, telemetry_retention_days, price_display,
            stripe_price_id IS NOT NULL AS purchasable
       FROM plans WHERE status = 'active' AND is_trial = FALSE
       ORDER BY seat_cap`,
  );
}
