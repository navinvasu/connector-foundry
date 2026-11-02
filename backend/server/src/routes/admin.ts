// Super-admin routes — Foundry operators (Naveen) onboard customers here.
// Mounted at /v1/admin behind requireAuth + requirePlatformAdmin.

import { Router } from 'express';
import { one, q, exec, withTx, uid, audit } from '../db.js';
import { validateBody, adminCustomerCreateSchema, adminCustomerPatchSchema, adminCustomerSeatsSchema, adminUserPatchSchema } from '../validate.js';
import { asyncHandler, HttpError } from '../errors.js';

export const adminRouter = Router();

const CUSTOMER_STATUSES = ['trialing', 'active', 'trial_expired', 'past_due', 'restricted', 'suspended'] as const;

function slugify(name: string): string {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 60);
}

async function customerSummary(id: string) {
  const c = await one<any>(
    `SELECT c.*, p.name AS plan_name, COALESCE(c.seat_override, p.seat_cap) AS seat_cap, p.project_cap,
            p.telemetry_retention_days, p.is_trial
       FROM customers c JOIN plans p ON p.id = c.plan_id
      WHERE c.id = $1`,
    [id],
  );
  if (!c) return null;
  const seats = await one<any>(
    `SELECT COUNT(*)::int AS n FROM customer_users WHERE customer_id = $1 AND status IN ('active','invited')`,
    [id],
  );
  const projects = await one<any>(
    `SELECT COUNT(*)::int AS n FROM projects WHERE customer_id = $1 AND status = 'active'`,
    [id],
  );
  return { ...c, seats_used: seats.n, projects_used: projects.n };
}

// GET /v1/admin/plans — the packages available for assignment.
adminRouter.get('/plans', asyncHandler(async (_req, res) => {
  const plans = await q(`SELECT * FROM plans WHERE status = 'active' ORDER BY seat_cap, project_cap`);
  res.json({ plans });
}));

// GET /v1/admin/customers — every customer with live usage.
adminRouter.get('/customers', asyncHandler(async (_req, res) => {
  const rows = await q<any>(`SELECT id FROM customers ORDER BY created_at DESC`);
  const customers = [];
  for (const r of rows) customers.push(await customerSummary(r.id));
  res.json({ customers });
}));

// GET /v1/admin/customers/:id — detail with members.
adminRouter.get('/customers/:id', asyncHandler(async (req, res) => {
  const c = await customerSummary(req.params.id);
  if (!c) return res.status(404).json({ error: 'Customer not found' });
  const members = await q<any>(
    `SELECT cu.id AS membership_id, cu.role, cu.status, cu.joined_at,
            u.id AS user_id, u.email, u.full_name, u.last_login_at
       FROM customer_users cu JOIN users u ON u.id = cu.user_id
      WHERE cu.customer_id = $1 ORDER BY cu.created_at`,
    [req.params.id],
  );
  res.json({ customer: c, members });
}));

// POST /v1/admin/customers — onboard a customer.
// Body: { name, plan_id?, start_trial?, owner_email?, owner_name? }
// start_trial (default true when plan is trial): opens the trial clock.
adminRouter.post('/customers', validateBody(adminCustomerCreateSchema), asyncHandler(async (req, res) => {
  try {
    const { name, plan_id, start_trial, owner_email, owner_name } = req.body as {
      name: string; plan_id?: string; start_trial?: boolean; owner_email?: string; owner_name?: string;
    };

    const plan = await one<any>(`SELECT * FROM plans WHERE id = $1 AND status = 'active'`, [plan_id ?? 'trial']);
    if (!plan) return res.status(400).json({ error: `Unknown plan: ${plan_id}` });

    const id = uid();
    const slug = slugify(String(name));
    const useTrial = start_trial ?? plan.is_trial;
    const now = new Date();
    const trialEnds = useTrial && plan.trial_duration_days
      ? new Date(now.getTime() + plan.trial_duration_days * 86400_000)
      : null;

    // 🐞 BE-02: customerSummary read through the pool *inside* the tx, so it
    // never saw the uncommitted insert and the 201 carried customer: null.
    // Summarize after commit instead.
    let ownerUserId: string | null = null;
    await withTx(async (t) => {
      await t.query(
        `INSERT INTO customers (id, name, slug, plan_id, status, trial_started_at, trial_ends_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, String(name).trim(), slug || null, plan.id,
         useTrial ? 'trialing' : 'active',
         useTrial ? now.toISOString() : null,
         trialEnds ? trialEnds.toISOString() : null],
      );
      if (owner_email) {
        const email = String(owner_email).trim().toLowerCase();
        let user = await one<any>(`SELECT * FROM users WHERE lower(email) = lower($1)`, [email]);
        if (!user) {
          const userId = uid();
          await t.query(
            `INSERT INTO users (id, email, full_name, status) VALUES ($1, $2, $3, 'active')`,
            [userId, email, owner_name ? String(owner_name) : null],
          );
          user = { id: userId };
        }
        await t.query(
          `INSERT INTO customer_users (id, customer_id, user_id, role, status, joined_at)
           VALUES ($1, $2, $3, 'owner', 'active', now())
           ON CONFLICT (customer_id, user_id) DO UPDATE SET role = 'owner', status = 'active', joined_at = now()`,
          [uid(), id, user.id],
        );
        ownerUserId = user.id;
      }
    });
    const customer = await customerSummary(id);

    res.status(201).json({ customer });
  } catch (e: any) {
    if (String(e?.message ?? '').includes('customers_slug_key')) {
      throw new HttpError(409, 'customer_name_conflict', 'A customer with a similar name already exists');
    }
    throw e;
  }
}));

// PATCH /v1/admin/customers/:id — rename, change plan, set status.
// Body: { name?, plan_id?, status? }
adminRouter.patch('/customers/:id', validateBody(adminCustomerPatchSchema), asyncHandler(async (req, res) => {
  const { name, plan_id, status } = req.body as { name?: string; plan_id?: string; status?: string };
  const sets: string[] = [];
  const vals: unknown[] = [];

  if (name !== undefined) {
    sets.push(`name = $${sets.length + 1}`); vals.push(String(name).trim());
  }
  if (plan_id !== undefined) {
    const plan = await one<any>(`SELECT * FROM plans WHERE id = $1 AND status = 'active'`, [plan_id]);
    if (!plan) return res.status(400).json({ error: `Unknown plan: ${plan_id}` });
    sets.push(`plan_id = $${sets.length + 1}`); vals.push(plan.id);
    // Moving onto the trial plan restarts the trial clock.
    if (plan.is_trial && plan.trial_duration_days) {
      const now = new Date();
      sets.push(`status = 'trialing'`);
      sets.push(`trial_started_at = $${sets.length + 1}`); vals.push(now.toISOString());
      sets.push(`trial_ends_at = $${sets.length + 1}`);
      vals.push(new Date(now.getTime() + plan.trial_duration_days * 86400_000).toISOString());
    }
  }
  if (status !== undefined) {
    sets.push(`status = $${sets.length + 1}`); vals.push(status);
  }
  if (sets.length === 0) return res.status(400).json({ error: 'Nothing to update. Allowed: name, plan_id, status' });

  vals.push(req.params.id);
  const n = await exec(
    `UPDATE customers SET ${sets.join(', ')}, updated_at = now() WHERE id = $${vals.length}`, vals);
  if (n === 0) return res.status(404).json({ error: 'Customer not found' });
  res.json({ customer: await customerSummary(req.params.id) });
}));

// PATCH /v1/admin/customers/:id/seats — BL-05: staff-granted seat override.
// Body: { seats: number | null, reason? } — sets the customer's TOTAL seat
// cap (not an add-on); null clears back to the plan default. Permanent
// until changed; every change is audit-logged with actor + reason (D-55).
adminRouter.patch('/customers/:id/seats', validateBody(adminCustomerSeatsSchema), asyncHandler(async (req, res) => {
  const { seats, reason } = req.body as { seats: number | null; reason?: string };
  const before = await one<any>(
    `SELECT c.seat_override, p.seat_cap FROM customers c JOIN plans p ON p.id = c.plan_id WHERE c.id = $1`,
    [req.params.id]);
  if (!before) return res.status(404).json({ error: 'Customer not found' });
  const actor = req.auth?.email ?? 'platform-admin';
  await exec(
    `UPDATE customers
        SET seat_override = $1::int, seat_override_reason = $2, seat_override_by = $3,
            seat_override_at = CASE WHEN $1::int IS NULL THEN NULL ELSE now() END,
            updated_at = now()
      WHERE id = $4`,
    [seats, seats === null ? null : (reason?.trim() || null), seats === null ? null : actor, req.params.id]);
  await audit(null, 'customer.seats_adjusted', 'customer', req.params.id, {
    from_effective: before.seat_override ?? Number(before.seat_cap),
    to_effective: seats ?? Number(before.seat_cap),
    seat_override: seats,
    reason: reason?.trim() || null,
    actor,
  });
  res.json({ customer: await customerSummary(req.params.id) });
}));

// POST /v1/admin/customers/:id/suspend and /reactivate — convenience wrappers.
adminRouter.post('/customers/:id/suspend', asyncHandler(async (req, res) => {
  const n = await exec(`UPDATE customers SET status = 'suspended', updated_at = now() WHERE id = $1`, [req.params.id]);
  if (n === 0) return res.status(404).json({ error: 'Customer not found' });
  res.json({ customer: await customerSummary(req.params.id) });
}));

adminRouter.post('/customers/:id/reactivate', asyncHandler(async (req, res) => {
  const c = await one<any>(`SELECT * FROM customers WHERE id = $1`, [req.params.id]);
  if (!c) return res.status(404).json({ error: 'Customer not found' });
  const backTo = c.plan_id === 'trial' ? 'trialing' : 'active';
  // Reactivation is also the way out of dunning — clear its clock/counters.
  await exec(
    `UPDATE customers SET status = $1, past_due_since = NULL, payment_failed_count = 0, last_payment_failed_at = NULL, updated_at = now() WHERE id = $2`,
    [backTo, c.id],
  );
  res.json({ customer: await customerSummary(req.params.id) });
}));

// GET /v1/admin/users — every human (for support / platform-admin management).
adminRouter.get('/users', asyncHandler(async (_req, res) => {
  const users = await q<any>(
    `SELECT u.id, u.email, u.full_name, u.is_platform_admin, u.status, u.last_login_at,
            u.cognito_sub IS NOT NULL AS has_cognito,
            (SELECT COUNT(*)::int FROM customer_users cu WHERE cu.user_id = u.id) AS memberships
       FROM users u ORDER BY u.created_at DESC LIMIT 200`,
  );
  res.json({ users });
}));

// PATCH /v1/admin/users/:id — platform-admin flag / suspend a human.
adminRouter.patch('/users/:id', validateBody(adminUserPatchSchema), asyncHandler(async (req, res) => {
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (req.body?.is_platform_admin !== undefined) {
    sets.push(`is_platform_admin = $${sets.length + 1}`); vals.push(!!req.body.is_platform_admin);
  }
  if (req.body?.status !== undefined) {
    sets.push(`status = $${sets.length + 1}`); vals.push(req.body.status);
  }
  if (sets.length === 0) return res.status(400).json({ error: 'Nothing to update. Allowed: is_platform_admin, status' });
  vals.push(req.params.id);
  const n = await exec(`UPDATE users SET ${sets.join(', ')}, updated_at = now() WHERE id = $${vals.length}`, vals);
  if (n === 0) return res.status(404).json({ error: 'User not found' });
  res.json({ user: await one(`SELECT * FROM users WHERE id = $1`, [req.params.id]) });
}));
