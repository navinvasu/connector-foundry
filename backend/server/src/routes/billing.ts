// Billing routes — trial → paid via Stripe.
//
//   GET  /v1/billing/plans                    purchasable tiers (any signed-in user)
//   GET  /v1/customers/:id/billing            status summary (owner/editor/viewer)
//   GET  /v1/customers/:id/billing/usage      metered invocations per project (TE-04)
//   GET  /v1/customers/:id/billing/usage/reconciliation
//                                             metered usage vs. one Stripe invoice (TE-04)
//   POST /v1/customers/:id/billing/checkout   owner → Stripe Checkout URL
//   POST /v1/customers/:id/billing/portal     owner → Stripe Customer Portal URL
//   POST /v1/billing/webhook                  Stripe → us (public; signature-verified,
//                                             raw body — mounted before express.json())
//
// Card details never touch our servers: Stripe hosts checkout and the portal.

import { Router } from 'express';
import express from 'express';
import { one } from '../db.js';
import { requireCustomerRole } from '../auth.js';
import { validateBody, checkoutSchema } from '../validate.js';
import {
  stripe, billingEnabled, purchasablePlans,
  createCheckoutSession, createPortalSession,
  parseWebhookEvent, applyWebhookEvent,
} from '../billing.js';
import { asyncHandler } from '../errors.js';
import { logger } from '../logger.js';
import { customerUsage, parseUsagePeriod, reconcileUsage, invoiceUsageLines } from '../metering.js';

export const billingRouter = Router();

const CONSOLE_BASE = (process.env.CONSOLE_BASE_URL ?? 'http://localhost:5174').replace(/\/$/, '');

// GET /v1/billing/plans — the tiers a customer can buy.
billingRouter.get('/billing/plans', asyncHandler(async (_req, res) => {
  res.json({ plans: await purchasablePlans(), billing_enabled: billingEnabled() });
}));

// GET /v1/customers/:id/billing — what the billing page shows.
billingRouter.get('/:id/billing', requireCustomerRole(['owner', 'editor', 'viewer']), asyncHandler(async (req, res) => {
  const c = await one<any>(
    `SELECT c.id, c.name, c.status, c.plan_id, p.name AS plan_name, p.price_display,
            c.trial_ends_at, c.past_due_since, c.payment_failed_count, c.last_payment_failed_at,
            c.stripe_customer_id IS NOT NULL AS has_stripe_customer,
            c.stripe_subscription_id IS NOT NULL AS has_subscription, c.billing_email
       FROM customers c JOIN plans p ON p.id = c.plan_id
      WHERE c.id = $1`,
    [req.params.id],
  );
  if (!c) return res.status(404).json({ error: 'Customer not found' });
  res.json({ billing: c, billing_enabled: billingEnabled() });
}));

// POST /v1/customers/:id/billing/checkout — owner starts (or converts) a subscription.
// Body: { plan_id }. Trialing and trial_expired customers convert; active
// customers without a subscription can also buy. Already-subscribed customers
// change plans through the portal instead.
billingRouter.post('/:id/billing/checkout', requireCustomerRole(['owner']), validateBody(checkoutSchema), asyncHandler(async (req, res) => {
  try {
    const s = stripe();
    if (!s) return res.status(503).json({ error: 'Billing is not configured (STRIPE_SECRET_KEY missing)' });
    const c = await one<any>(`SELECT * FROM customers WHERE id = $1`, [req.params.id]);
    if (!c) return res.status(404).json({ error: 'Customer not found' });
    if (c.status === 'suspended') {
      return res.status(403).json({ error: 'This workspace is suspended — contact support to reactivate' });
    }
    if (c.stripe_subscription_id) {
      return res.status(409).json({
        error: 'This workspace already has a subscription — use "Manage billing" to change plans',
      });
    }
    const { plan_id } = req.body as { plan_id: string };

    // Triailing customers keep their remaining free days — Stripe bills when
    // the trial runs out. Everyone else is billed from today.
    const trialDaysLeft =
      c.status === 'trialing' && c.trial_ends_at
        ? Math.max(0, Math.ceil((new Date(c.trial_ends_at).getTime() - Date.now()) / 86400_000))
        : 0;

    const url = await createCheckoutSession(s, {
      customerId: c.id,
      customerName: c.name,
      planId: String(plan_id),
      email: req.auth!.email,
      trialDaysLeft,
      successUrl: `${CONSOLE_BASE}/billing/success?customer=${c.id}`,
      cancelUrl: `${CONSOLE_BASE}/billing/cancel?customer=${c.id}`,
    });
    res.json({ url });
  } catch (e: any) {
    throw e;
  }
}));

// POST /v1/customers/:id/billing/portal — owner self-serves plan changes.
billingRouter.post('/:id/billing/portal', requireCustomerRole(['owner']), asyncHandler(async (req, res) => {
  try {
    const s = stripe();
    if (!s) return res.status(503).json({ error: 'Billing is not configured (STRIPE_SECRET_KEY missing)' });
    const url = await createPortalSession(s, req.params.id, `${CONSOLE_BASE}/customers/${req.params.id}/billing`);
    res.json({ url });
  } catch (e: any) {
    throw e;
  }
}));

// GET /v1/customers/:id/billing/invoices — recent invoices (owner/editor/viewer).
billingRouter.get('/:id/billing/invoices', requireCustomerRole(['owner', 'editor', 'viewer']), asyncHandler(async (req, res) => {
  try {
    const s = stripe();
    if (!s) return res.status(503).json({ error: 'Billing is not configured (STRIPE_SECRET_KEY missing)' });
    const c = await one<any>(`SELECT stripe_customer_id FROM customers WHERE id = $1`, [req.params.id]);
    if (!c?.stripe_customer_id) return res.json({ invoices: [] });
    const list = await s.invoices.list({ customer: c.stripe_customer_id as string, limit: 12 });
    res.json({
      invoices: list.data.map((inv) => ({
        id: inv.id,
        number: inv.number,
        amount_due: inv.amount_due,
        currency: inv.currency,
        status: inv.status,
        created: new Date(inv.created * 1000).toISOString(),
        hosted_url: inv.hosted_invoice_url,
      })),
    });
  } catch (e: any) {
    throw e;
  }
}));

// GET /v1/customers/:id/billing/usage — metered usage (TE-04).
// Invocation counts per project for a period (`?from=`/`?to=` ISO dates,
// default the current UTC calendar month), aggregated from telemetry_events
// — the same rows the Operate screen reads, so the meter can never drift
// from observed traffic. Any member can read it (billing transparency);
// metering itself is read-only and never gated on Stripe being configured.
billingRouter.get('/:id/billing/usage', requireCustomerRole(['owner', 'editor', 'viewer']), asyncHandler(async (req, res) => {
  const parsed = parseUsagePeriod(req.query as Record<string, unknown>);
  if (!parsed.ok) {
    return res.status(400).json({ error: 'invalid_request', code: 'invalid_request', fields: parsed.fields });
  }
  const usage = await customerUsage(req.params.id, parsed.period);
  if (!usage) return res.status(404).json({ error: 'Customer not found' });
  res.json({ usage });
}));

// GET /v1/customers/:id/billing/usage/reconciliation?invoice_id=&from=&to=
// TE-04's acceptance check as an endpoint: fetch one Stripe invoice and
// compare its usage line items (metadata.foundry_project_id + quantity)
// against the metered counts for the same period. The comparison logic is
// pure (metering.ts) and unit-tested against fabricated invoices; this
// handler only adds the live Stripe fetch + ownership check — an invoice
// belonging to a different Stripe customer is a 400, never reconciled.
billingRouter.get('/:id/billing/usage/reconciliation', requireCustomerRole(['owner', 'editor', 'viewer']), asyncHandler(async (req, res) => {
  const invoiceId = (req.query as Record<string, unknown>).invoice_id;
  if (typeof invoiceId !== 'string' || invoiceId.length === 0) {
    return res.status(400).json({
      error: 'invalid_request', code: 'invalid_request',
      fields: { invoice_id: 'invoice_id query parameter is required' },
    });
  }
  const parsed = parseUsagePeriod(req.query as Record<string, unknown>);
  if (!parsed.ok) {
    return res.status(400).json({ error: 'invalid_request', code: 'invalid_request', fields: parsed.fields });
  }
  const s = stripe();
  if (!s) return res.status(503).json({ error: 'Billing is not configured (STRIPE_SECRET_KEY missing)' });
  const usage = await customerUsage(req.params.id, parsed.period);
  if (!usage) return res.status(404).json({ error: 'Customer not found' });
  const c = await one<any>(`SELECT stripe_customer_id FROM customers WHERE id = $1`, [req.params.id]);
  let inv;
  try {
    inv = await s.invoices.retrieve(invoiceId);
  } catch (e: any) {
    if (e?.statusCode === 404) return res.status(404).json({ error: 'Invoice not found' });
    throw e;
  }
  const invoiceCustomer = typeof inv.customer === 'string' ? inv.customer : inv.customer?.id ?? null;
  if (c?.stripe_customer_id && invoiceCustomer && invoiceCustomer !== c.stripe_customer_id) {
    return res.status(400).json({ error: 'Invoice belongs to a different Stripe customer' });
  }
  res.json({
    invoice_id: invoiceId,
    usage,
    reconciliation: reconcileUsage(usage.projects, invoiceUsageLines(inv)),
  });
}));

// ─── Webhook (public; mounted before express.json so the body stays raw) ─────

export const billingWebhookRouter = Router();

// The raw-body parser lives on the route itself so signature verification
// sees the exact bytes Stripe signed — express.json() must not touch it.
billingWebhookRouter.post(
  '/v1/billing/webhook',
  express.raw({ type: 'application/json' }),
  asyncHandler(async (req, res) => {
    const signature = req.headers['stripe-signature'] as string | undefined;
    try {
      const event = parseWebhookEvent(req.body as Buffer, signature);
      const summary = await applyWebhookEvent(event);
      logger.info({ msg: 'billing webhook', request_id: req.id, event_id: event.id, event_type: event.type, summary });
      res.json({ received: true });
    } catch (e: any) {
      logger.error({ msg: 'billing webhook error', request_id: req.id, error: e?.message ?? String(e) });
      throw e;
    }
  }),
);
