// Customer user management — a customer's owner manages their own users.
// Mounted at /v1/customers behind requireAuth. Write actions need the
// `owner` role (requireCustomerRole); reads allow owner/editor/viewer.
// Invites are pending customer_users rows; the invitee completes Cognito
// signup and is linked by email on first login (see auth.ts).

import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import { one, q, exec, withTx, uid } from '../db.js';
import { requireCustomerRole, customerWritable } from '../auth.js';
import { ROLES, validateBody, inviteSchema, memberPatchSchema } from '../validate.js';
import { asyncHandler } from '../errors.js';
import { hashInviteToken } from '../invites.js';

export const membersRouter = Router();

async function seatUsage(customerId: string) {
  const plan = await one<any>(
    `SELECT COALESCE(c.seat_override, p.seat_cap) AS seat_cap, c.seat_override,
            p.seat_cap AS plan_seat_cap, p.project_cap
       FROM customers c JOIN plans p ON p.id = c.plan_id WHERE c.id = $1`,
    [customerId],
  );
  const seats = await one<any>(
    `SELECT COUNT(*)::int AS n FROM customer_users WHERE customer_id = $1 AND status IN ('active','invited')`,
    [customerId],
  );
  const projects = await one<any>(
    `SELECT COUNT(*)::int AS n FROM projects WHERE customer_id = $1 AND status = 'active'`,
    [customerId],
  );
  return {
    seats_used: seats.n, seat_cap: Number(plan.seat_cap),
    // BL-05: expose the override so the console can say whose number this is.
    seat_override: plan.seat_override == null ? null : Number(plan.seat_override),
    plan_seat_cap: Number(plan.plan_seat_cap),
    projects_used: projects.n, project_cap: Number(plan.project_cap),
  };
}

// GET /v1/customers/:id/users — roster.
membersRouter.get('/:id/users', requireCustomerRole(['owner', 'editor', 'viewer']), asyncHandler(async (req, res) => {
  const members = await q<any>(
    `SELECT cu.id AS membership_id, cu.role, cu.status, cu.joined_at,
            cu.invite_expires_at,
            u.id AS user_id, u.email, u.full_name, u.last_login_at,
            inv.email AS invited_by_email
       FROM customer_users cu
       JOIN users u ON u.id = cu.user_id
       LEFT JOIN users inv ON inv.id = cu.invited_by
      WHERE cu.customer_id = $1
      ORDER BY cu.created_at`,
    [req.params.id],
  );
  res.json({ members, usage: await seatUsage(req.params.id) });
}));

// GET /v1/customers/:id/usage — plan, status, caps, trial clock.
membersRouter.get('/:id/usage', requireCustomerRole(['owner', 'editor', 'viewer']), asyncHandler(async (req, res) => {
  const c = await one<any>(
    `SELECT c.id, c.name, c.status, c.trial_ends_at, p.id AS plan_id, p.name AS plan_name,
            p.seat_cap, p.project_cap, p.telemetry_retention_days, p.is_trial
       FROM customers c JOIN plans p ON p.id = c.plan_id WHERE c.id = $1`,
    [req.params.id],
  );
  if (!c) return res.status(404).json({ error: 'Customer not found' });
  res.json({ ...(await seatUsage(req.params.id)), customer: c });
}));

// POST /v1/customers/:id/users/invite — owner invites by email.
// Body: { email, role?, full_name? }
membersRouter.post('/:id/users/invite', requireCustomerRole(['owner']), validateBody(inviteSchema), asyncHandler(async (req, res) => {
  try {
    if (!customerWritable(req.customer!)) {
      return res.status(403).json({ error: `Customer is ${req.customer!.customerStatus} — invites are disabled` });
    }
    const { email, role, full_name } = req.body as { email: string; role?: string; full_name?: string };
    const usage = await seatUsage(req.params.id);
    if (usage.seats_used >= usage.seat_cap) {
      return res.status(409).json({
        error: `Seat limit reached (${usage.seats_used}/${usage.seat_cap}). Upgrade the plan to invite more users.`,
      });
    }
    const normalized = String(email).trim().toLowerCase();
    const invite = await withTx(async (t) => {
      let user = await one<any>(`SELECT * FROM users WHERE lower(email) = lower($1)`, [normalized]);
      if (!user) {
        const userId = uid();
        await t.query(`INSERT INTO users (id, email, full_name, status) VALUES ($1, $2, $3, 'active')`,
          [userId, normalized, full_name ? String(full_name) : null]);
        user = { id: userId, email: normalized };
      }
      const existing = await one<any>(
        `SELECT * FROM customer_users WHERE customer_id = $1 AND user_id = $2`,
        [req.params.id, user.id],
      );
      if (existing) {
        if (existing.status === 'active') return { already_member: true, user };
        // Re-invite: refresh the token + expiry. SE-10: only the token's
        // SHA-256 hash is stored; the plaintext leaves solely in this
        // response (and, once BE-14 lands, in the SES email).
        const token = randomBytes(24).toString('hex');
        const expires = new Date(Date.now() + 7 * 86400_000).toISOString();
        await t.query(
          `UPDATE customer_users SET status = 'invited', invite_token_hash = $1, invite_expires_at = $2,
                  role = $3, invited_by = $4 WHERE id = $5`,
          [hashInviteToken(token), expires, role ?? existing.role, req.auth!.userId, existing.id],
        );
        return { reinvited: true, user, invite_token: token, invite_expires_at: expires };
      }
      const token = randomBytes(24).toString('hex');
      const expires = new Date(Date.now() + 7 * 86400_000).toISOString();
      await t.query(
        `INSERT INTO customer_users (id, customer_id, user_id, role, status, invited_by, invite_token_hash, invite_expires_at)
         VALUES ($1, $2, $3, $4, 'invited', $5, $6, $7)`,
        [uid(), req.params.id, user.id, role ?? 'viewer', req.auth!.userId, hashInviteToken(token), expires],
      );
      return { invited: true, user, invite_token: token, invite_expires_at: expires };
    });
    if ((invite as any).already_member) {
      return res.status(409).json({ error: 'That user is already a member of this customer' });
    }
    // SE-10: acceptance is token-checked — the invitee redeems the token
    // (POST /v1/invites/:token/redeem) after signing in; the SES email
    // carrying the link is BE-14's remaining half. The plaintext token in
    // this response is the inviter's manual copy-link fallback, shown once.
    res.status(201).json(invite);
  } catch (e: any) {
    throw e;
  }
}));

// PATCH /v1/customers/:id/users/:userId — owner changes role or suspends.
// Body: { role?, status? }  (status: active | suspended)
membersRouter.patch('/:id/users/:userId', requireCustomerRole(['owner']), validateBody(memberPatchSchema), asyncHandler(async (req, res) => {
  const { role, status } = req.body as { role?: string; status?: string };
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (role !== undefined) {
    sets.push(`role = $${sets.length + 1}`); vals.push(role);
  }
  if (status !== undefined) {
    sets.push(`status = $${sets.length + 1}`); vals.push(status);
  }
  if (sets.length === 0) return res.status(400).json({ error: 'Nothing to update. Allowed: role, status' });

  // Never demote/suspend the last active owner.
  if (role !== undefined || status === 'suspended') {
    const owners = await one<any>(
      `SELECT COUNT(*)::int AS n FROM customer_users
        WHERE customer_id = $1 AND role = 'owner' AND status = 'active' AND user_id <> $2`,
      [req.params.id, req.params.userId],
    );
    const target = await one<any>(
      `SELECT role, status FROM customer_users WHERE customer_id = $1 AND user_id = $2`,
      [req.params.id, req.params.userId],
    );
    if (target?.role === 'owner' && target?.status === 'active' && owners.n === 0) {
      return res.status(409).json({ error: 'Cannot demote or suspend the last active owner' });
    }
  }
  vals.push(req.params.id, req.params.userId);
  const n = await exec(
    `UPDATE customer_users SET ${sets.join(', ')} WHERE customer_id = $${vals.length - 1} AND user_id = $${vals.length}`,
    vals,
  );
  if (n === 0) return res.status(404).json({ error: 'Membership not found' });
  res.json({ ok: true });
}));

// DELETE /v1/customers/:id/users/:userId — owner removes a member.
membersRouter.delete('/:id/users/:userId', requireCustomerRole(['owner']), asyncHandler(async (req, res) => {
  if (req.params.userId === req.auth!.userId) {
    return res.status(400).json({ error: 'You cannot remove yourself; ask another owner' });
  }
  const target = await one<any>(
    `SELECT role, status FROM customer_users WHERE customer_id = $1 AND user_id = $2`,
    [req.params.id, req.params.userId],
  );
  if (!target) return res.status(404).json({ error: 'Membership not found' });
  if (target.role === 'owner' && target.status === 'active') {
    const owners = await one<any>(
      `SELECT COUNT(*)::int AS n FROM customer_users
        WHERE customer_id = $1 AND role = 'owner' AND status = 'active' AND user_id <> $2`,
      [req.params.id, req.params.userId],
    );
    if (owners.n === 0) return res.status(409).json({ error: 'Cannot remove the last active owner' });
  }
  await exec(`DELETE FROM customer_users WHERE customer_id = $1 AND user_id = $2`,
    [req.params.id, req.params.userId]);
  res.json({ ok: true });
}));
