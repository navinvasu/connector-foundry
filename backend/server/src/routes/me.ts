import { Router } from 'express';
import { customerWritable } from '../auth.js';
import { one, withTx, uid } from '../db.js';
import { validateBody, orgCreateSchema } from '../validate.js';
import { asyncHandler, HttpError } from '../errors.js';

export const meRouter = Router();

// GET /v1/me — who the caller is and which workspaces they can act in.
// The console uses this for the workspace picker (e.g. the new-project
// wizard); `writable` mirrors the server's own write gate.
meRouter.get('/me', asyncHandler(async (req, res) => {
  const a = req.auth!;
  res.json({
    user: {
      id: a.userId,
      email: a.email,
      full_name: a.fullName,
      is_platform_admin: a.isPlatformAdmin,
    },
    memberships: a.memberships.map((m) => ({
      customer_id: m.customerId,
      customer_name: m.customerName,
      customer_status: m.customerStatus,
      plan_id: m.planId,
      plan_name: m.planName,
      role: m.role,
      membership_status: m.membershipStatus,
      writable: (m.role === 'owner' || m.role === 'editor') && customerWritable(m),
      project_cap: m.projectCap,
      telemetry_retention_days: m.telemetryRetentionDays,
      trial_ends_at: m.trialEndsAt,
    })),
  });
}));

// ─── FE-07: self-serve organization creation ────────────────────────────────
// "Creating my organization makes me its owner." Until FE-07 the only way a
// customer row came to exist was a platform admin creating one (BE-11) — a
// signed-in user with no membership hit a dead end in the console. This is
// that user's door: POST /v1/me/organization creates the customer on the
// trial plan (the same plan + 14-day clock admin-create defaults to), makes
// the caller its active owner. The organization starts empty (D-87): the
// first project is the customer's own API.
//
// Guard: a non-admin caller who already holds an active membership gets a
// 409 (organization_already_exists, naming that customer) rather than a
// second trial — one self-serve organization per user keeps trial farming
// out of the free tier; additional workspaces arrive via invite (FE-04 /
// BE-14) or admin-create. Platform admins bypass the guard (they operate
// the platform; the admin route remains their normal door, this just keeps
// the console flow usable for them too). See D-47.

function slugify(name: string): string {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 60);
}

async function customerSummary(id: string) {
  const c = await one<any>(
    `SELECT c.*, p.name AS plan_name, p.seat_cap, p.project_cap,
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

// POST /v1/me/organization — body: { name }
// 201: { customer } — the caller is the customer's owner (no sample project, D-87).
meRouter.post('/me/organization', validateBody(orgCreateSchema), asyncHandler(async (req, res) => {
  const a = req.auth!;
  const active = a.memberships.filter((m) => m.membershipStatus === 'active');
  if (!a.isPlatformAdmin && active.length > 0) {
    return res.status(409).json({
      error: `You already belong to "${active[0].customerName}" — additional workspaces are created by an admin or via invite.`,
      code: 'organization_already_exists',
      customer_id: active[0].customerId,
    });
  }

  const { name } = req.body as { name: string };
  const plan = await one<any>(`SELECT * FROM plans WHERE id = 'trial' AND status = 'active'`);
  if (!plan) {
    throw new HttpError(500, 'trial_plan_missing', 'The trial plan is not configured — contact support.');
  }

  const id = uid();
  const now = new Date();
  const trialEnds = plan.trial_duration_days
    ? new Date(now.getTime() + plan.trial_duration_days * 86400_000)
    : null;

  try {
    await withTx(async (t) => {
      await t.query(
        `INSERT INTO customers (id, name, slug, plan_id, status, trial_started_at, trial_ends_at)
         VALUES ($1, $2, $3, $4, 'trialing', $5, $6)`,
        [id, String(name).trim(), slugify(String(name)) || null, plan.id,
         now.toISOString(), trialEnds ? trialEnds.toISOString() : null],
      );
      await t.query(
        `INSERT INTO customer_users (id, customer_id, user_id, role, status, joined_at)
         VALUES ($1, $2, $3, 'owner', 'active', now())
         ON CONFLICT (customer_id, user_id) DO UPDATE SET role = 'owner', status = 'active', joined_at = now()`,
        [uid(), id, a.userId],
      );
    });
  } catch (e: any) {
    if (String(e?.message ?? '').includes('customers_slug_key')) {
      throw new HttpError(409, 'customer_name_conflict', 'An organization with a similar name already exists — pick a different name.');
    }
    throw e;
  }
  // Summarize after commit (the BE-02 lesson: reads inside the tx miss the
  // uncommitted customer and return null).
  const customer = await customerSummary(id);

  res.status(201).json({ customer });
}));
