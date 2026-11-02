// Authentication + user context for the Connector Foundry server.
//
// Login is Amazon Cognito (shared user pool, us-east-1 — locked decision
// 2026-09-27). The console signs users in through Cognito's hosted UI and
// sends the access JWT as `Authorization: Bearer <token>`. This module
// verifies the JWT against the pool's JWKS, resolves the human (users row,
// matched by cognito_sub, or by email on first login) and attaches the full
// user context — user, platform-admin flag, and every customer membership
// with plan + role — to `req.auth`. Handlers never re-derive identity.
//
// Local dev: set CF_DEV_AUTH=true explicitly (dev.sh does; SE-07 made the
// default OFF so an unset variable can never enable the bypass) and
// requests are authenticated as a seeded platform-admin dev user. Never
// enable CF_DEV_AUTH in any deployed environment — production refuses to
// boot with it (src/boot-guards.ts).

import { Request, Response, NextFunction } from 'express';
import { createRemoteJWKSet, jwtVerify, errors as joseErrors } from 'jose';
import { one, q, exec, uid } from './db.js';
import { sweepDunning } from './dunning.js';
import { HttpError } from './errors.js';

const REGION = process.env.COGNITO_REGION ?? 'us-east-1';
const POOL_ID = process.env.COGNITO_USER_POOL_ID ?? '';
const CLIENT_ID = process.env.COGNITO_CLIENT_ID ?? '';
export const DEV_AUTH = (process.env.CF_DEV_AUTH ?? 'false') === 'true';

const ISSUER = `https://cognito-idp.${REGION}.amazonaws.com/${POOL_ID}`;

let JWKS: ReturnType<typeof createRemoteJWKSet> | null = null;
function getJwks() {
  if (!JWKS) {
    if (!POOL_ID) throw new Error('COGNITO_USER_POOL_ID is not set');
    JWKS = createRemoteJWKSet(new URL(`${ISSUER}/.well-known/jwks.json`));
  }
  return JWKS;
}

export interface Membership {
  customerId: string;
  customerName: string;
  customerStatus: string;
  planId: string;
  planName: string;
  seatCap: number;
  projectCap: number;
  telemetryRetentionDays: number;
  trialEndsAt: string | null;
  /** BL-04: when the customer entered past_due (null when not dunning). */
  pastDueSince: string | null;
  role: 'owner' | 'editor' | 'viewer';
  membershipStatus: string;
}

export interface AuthContext {
  userId: string;
  email: string;
  fullName: string | null;
  isPlatformAdmin: boolean;
  memberships: Membership[];
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

async function loadMemberships(userId: string): Promise<Membership[]> {
  const rows = await q<any>(
    `SELECT cu.customer_id, c.name AS customer_name, c.status AS customer_status,
            c.plan_id, p.name AS plan_name, COALESCE(c.seat_override, p.seat_cap) AS seat_cap, p.project_cap,
            p.telemetry_retention_days, c.trial_ends_at, c.past_due_since,
            cu.role, cu.status AS membership_status
       FROM customer_users cu
       JOIN customers c ON c.id = cu.customer_id
       JOIN plans p ON p.id = c.plan_id
      WHERE cu.user_id = $1 AND cu.status = 'active'
      ORDER BY c.created_at`,
    [userId],
  );
  return rows.map((r) => ({
    customerId: r.customer_id,
    customerName: r.customer_name,
    customerStatus: r.customer_status,
    planId: r.plan_id,
    planName: r.plan_name,
    seatCap: Number(r.seat_cap),
    projectCap: Number(r.project_cap),
    telemetryRetentionDays: Number(r.telemetry_retention_days),
    trialEndsAt: r.trial_ends_at ? new Date(r.trial_ends_at).toISOString() : null,
    pastDueSince: r.past_due_since ? new Date(r.past_due_since).toISOString() : null,
    role: r.role,
    membershipStatus: r.membership_status,
  }));
}

/** Lazy trial sweep: flip customers whose trial clock ran out. */
async function sweepExpiredTrials(memberships: Membership[]): Promise<void> {
  const now = new Date();
  for (const m of memberships) {
    if (m.customerStatus === 'trialing' && m.trialEndsAt && new Date(m.trialEndsAt) <= now) {
      await exec(`UPDATE customers SET status = 'trial_expired', updated_at = now() WHERE id = $1`, [m.customerId]);
      m.customerStatus = 'trial_expired';
    }
  }
}

/** Lazy lifecycle sweeps run on every auth load (trials + BL-04 dunning). */
async function sweepMemberships(memberships: Membership[]): Promise<void> {
  await sweepExpiredTrials(memberships);
  await sweepDunning(memberships);
}

/**
 * FE-08: invite acceptance. An invite is a pending (`invited`) membership
 * created by an owner (BE-14); the invitee accepts by signing in — Cognito
 * resolves them to the pre-created users row by email (see authFromCognito),
 * and their first authenticated request flips every unexpired pending
 * membership to `active`, so the workspace is in that same request's auth
 * context ("invite → pending → accept → active" without an accept-link —
 * the SES email + token-link flow remains BE-14's open half).
 *
 * SE-10 narrows this to the legacy fallback: invites minted since SE-10
 * carry a token hash and are accepted ONLY by redeeming the token
 * (POST /v1/invites/:token/redeem — see invites.ts). This sweep therefore
 * flips only pending rows with no token hash (pre-SE-10 invites recorded
 * before hash-at-rest), so sign-in alone can no longer claim a hashed
 * invite (SE-06 F-5).
 *
 * Expired invites stay `invited`: the owner's re-invite refreshes token +
 * expiry, and the next sign-in accepts. Suspended memberships are never
 * touched. Runs before loadMemberships on both auth paths (the
 * sweep-on-load pattern of sweepExpiredTrials / BL-04 dunning).
 * Returns how many memberships were activated.
 */
export async function acceptPendingInvites(userId: string): Promise<number> {
  return exec(
    `UPDATE customer_users
        SET status = 'active', joined_at = COALESCE(joined_at, now()),
            invite_token_hash = NULL, invite_expires_at = NULL
      WHERE user_id = $1 AND status = 'invited' AND invite_token_hash IS NULL
        AND (invite_expires_at IS NULL OR invite_expires_at > now())`,
    [userId],
  );
}

/**
 * A customer can be written to while trialing/active — and while past_due
 * (BL-04's reminder/grace stage). trial_expired, restricted (dunning
 * read-only stage), and suspended cannot.
 */
export function customerWritable(m: Membership): boolean {
  return m.customerStatus === 'active' || m.customerStatus === 'trialing' || m.customerStatus === 'past_due';
}

// ─── Dev identity (CF_DEV_AUTH=true only) ────────────────────────────────────
// Seeds a platform-admin dev user + a dev workspace so every code path runs
// against real rows without a Cognito pool.

const DEV_EMAIL = process.env.CF_DEV_EMAIL ?? 'dev@connectorfoundry.local';

/** The one-click customer persona (IN-09): a non-admin owner of the Dev
 *  Workspace, seeded on first persona request so the tenant plane is
 *  testable without an invite round-trip. Dev bypass only. */
export const DEV_CUSTOMER_EMAIL = 'customer@connectorfoundry.local';

/** Ensure the Dev Workspace exists and the user holds an active owner
 *  membership in it (shared by the default dev identity and the customer
 *  persona). */
async function ensureDevWorkspaceMembership(userId: string): Promise<void> {
  let customer = await one<any>(`SELECT * FROM customers WHERE slug = 'dev-workspace'`);
  if (!customer) {
    const cid = uid();
    await exec(
      `INSERT INTO customers (id, name, slug, plan_id, status) VALUES ($1, 'Dev Workspace', 'dev-workspace', 'starter', 'active')`,
      [cid],
    );
    customer = await one<any>(`SELECT * FROM customers WHERE id = $1`, [cid]);
  }
  const membership = await one<any>(
    `SELECT * FROM customer_users WHERE customer_id = $1 AND user_id = $2`,
    [customer.id, userId],
  );
  if (!membership) {
    await exec(
      `INSERT INTO customer_users (id, customer_id, user_id, role, status, joined_at)
       VALUES ($1, $2, $3, 'owner', 'active', now())`,
      [uid(), customer.id, userId],
    );
  }
}

async function ensureDevIdentity(): Promise<AuthContext> {
  let user = await one<any>(`SELECT * FROM users WHERE lower(email) = lower($1)`, [DEV_EMAIL]);
  if (!user) {
    const id = uid();
    await exec(
      `INSERT INTO users (id, email, full_name, is_platform_admin, status) VALUES ($1, $2, $3, TRUE, 'active')`,
      [id, DEV_EMAIL, 'Foundry Dev Admin'],
    );
    user = await one<any>(`SELECT * FROM users WHERE id = $1`, [id]);
  } else if (!user.is_platform_admin) {
    await exec(`UPDATE users SET is_platform_admin = TRUE, updated_at = now() WHERE id = $1`, [user.id]);
    user.is_platform_admin = true;
  }
  await ensureDevWorkspaceMembership(user.id);
  await exec(`UPDATE users SET last_login_at = now() WHERE id = $1`, [user.id]);
  await acceptPendingInvites(user.id);
  const memberships = await loadMemberships(user.id);
  await sweepMemberships(memberships);
  return {
    userId: user.id,
    email: user.email,
    fullName: user.full_name,
    isPlatformAdmin: true,
    memberships,
  };
}

// ─── Dev personas (IN-09, CF_DEV_AUTH=true only) ─────────────────────────────
// A request may carry `x-dev-as: <email>` to act as that person instead of
// the default dev admin, plus `x-dev-as-admin: 1` to make them a platform
// operator. Personas are find-or-created WITHOUT the dev-workspace
// membership, so staff-only, invited-member, and brand-new-user flows are
// all testable locally. Strictly inside the dev bypass: production auth
// (authFromCognito) never reads these headers. The console's dev persona
// switcher (Layout) sets them via localStorage.

const PERSONA_EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

async function ensurePersonaIdentity(email: string, asAdmin: boolean): Promise<AuthContext> {
  let user = await one<any>(`SELECT * FROM users WHERE lower(email) = lower($1)`, [email]);
  if (!user) {
    const id = uid();
    await exec(
      `INSERT INTO users (id, email, full_name, is_platform_admin, status) VALUES ($1, $2, $3, $4, 'active')`,
      [id, email, email.split('@')[0], asAdmin],
    );
    user = await one<any>(`SELECT * FROM users WHERE id = $1`, [id]);
  } else if (asAdmin && !user.is_platform_admin) {
    await exec(`UPDATE users SET is_platform_admin = TRUE, updated_at = now() WHERE id = $1`, [user.id]);
    user = { ...user, is_platform_admin: true };
  }
  await exec(`UPDATE users SET last_login_at = now() WHERE id = $1`, [user.id]);
  // The customer preset persona skips the invite round-trip: it owns the
  // Dev Workspace outright. Any other persona starts with exactly the
  // memberships it already holds (invites included).
  if (email === DEV_CUSTOMER_EMAIL) await ensureDevWorkspaceMembership(user.id);
  // First persona request activates any pending invite, exactly like a
  // first real sign-in (FE-08) — this is what makes the invited-member
  // flow testable end to end.
  await acceptPendingInvites(user.id);
  const memberships = await loadMemberships(user.id);
  await sweepMemberships(memberships);
  return {
    userId: user.id,
    email: user.email,
    fullName: user.full_name,
    isPlatformAdmin: !!user.is_platform_admin,
    memberships,
  };
}

async function devIdentityFor(req: Request): Promise<AuthContext> {
  const as = String(req.headers?.['x-dev-as'] ?? '').trim().toLowerCase();
  if (as && PERSONA_EMAIL_RE.test(as) && as !== DEV_EMAIL.toLowerCase()) {
    return ensurePersonaIdentity(as, String(req.headers?.['x-dev-as-admin'] ?? '') === '1');
  }
  return ensureDevIdentity();
}

// ─── Cognito JWT verification ────────────────────────────────────────────────

async function authFromCognito(req: Request): Promise<AuthContext> {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) throw Object.assign(new Error('Missing Authorization bearer token'), { status: 401 });

  let verified;
  try {
    verified = await jwtVerify(token, getJwks(), { issuer: ISSUER });
  } catch (e) {
    // SE-11 (SE-06 F-7): every jose verification failure — malformed,
    // expired, wrong issuer, bad signature, no matching key — is a client
    // auth failure (401), not a server error. The jose detail stays
    // server-side; clients get one generic line. Non-jose failures (e.g.
    // COGNITO_USER_POOL_ID unset in getJwks) are config errors and keep
    // propagating, so the error middleware answers an honest 500.
    if (e instanceof joseErrors.JOSEError) {
      throw new HttpError(401, 'unauthorized', 'Invalid or expired access token');
    }
    throw e;
  }
  const { payload } = verified;

  if (payload.token_use !== 'access') {
    throw Object.assign(new Error('Only Cognito access tokens are accepted'), { status: 401 });
  }
  const tokenClient = (payload as any).client_id;
  if (CLIENT_ID && tokenClient !== CLIENT_ID) {
    throw Object.assign(new Error('Token was not issued for this app client'), { status: 401 });
  }
  const sub = String(payload.sub ?? '');
  if (!sub) throw Object.assign(new Error('Token has no subject'), { status: 401 });

  // Resolve the human: by cognito_sub, else by email (first login links them).
  let user = await one<any>(`SELECT * FROM users WHERE cognito_sub = $1`, [sub]);
  if (!user) {
    const email = String((payload as any).email ?? payload['username'] ?? '');
    if (email) {
      const byEmail = await one<any>(`SELECT * FROM users WHERE lower(email) = lower($1)`, [email]);
      // SE-10 (SE-06 F-5): email-based linking requires a verified email
      // claim. Without it, anyone able to register an unverified address
      // in the pool could be linked onto a pre-created row (and its
      // pending invites) — the pre-hijack corner. An unverified claim
      // simply doesn't link; the caller gets the generic no-account 403.
      const emailVerified = (payload as any).email_verified === true || (payload as any).email_verified === 'true';
      if (byEmail && !byEmail.cognito_sub && emailVerified) {
        await exec(`UPDATE users SET cognito_sub = $1, updated_at = now() WHERE id = $2`, [sub, byEmail.id]);
        user = { ...byEmail, cognito_sub: sub };
      }
    }
  }
  if (!user) {
    throw Object.assign(
      new Error('No Foundry account for this login — ask your workspace admin for an invite'),
      { status: 403 },
    );
  }
  if (user.status !== 'active') {
    throw Object.assign(new Error('Account is suspended'), { status: 403 });
  }
  await exec(`UPDATE users SET last_login_at = now() WHERE id = $1`, [user.id]);
  await acceptPendingInvites(user.id);
  const memberships = await loadMemberships(user.id);
  await sweepMemberships(memberships);
  return {
    userId: user.id,
    email: user.email,
    fullName: user.full_name,
    isPlatformAdmin: !!user.is_platform_admin,
    memberships,
  };
}

// ─── Middleware ─────────────────────────────────────────────────────────────

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  try {
    req.auth = DEV_AUTH ? await devIdentityFor(req) : await authFromCognito(req);
    next();
  } catch (e: any) {
    // Auth failures throw with a numeric .status (401/403); anything else is
    // unexpected → the central error middleware maps both safely.
    next(e);
  }
}

export function requirePlatformAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.auth?.isPlatformAdmin) {
    return res.status(403).json({ error: 'Platform admin only' });
  }
  next();
}

/** Find the caller's membership in a customer, or null. */
export function membershipIn(req: Request, customerId: string): Membership | null {
  return req.auth?.memberships.find((m) => m.customerId === customerId) ?? null;
}

/**
 * Middleware factory: require the caller to hold one of `roles` in the
 * customer identified by the `:id` route param. Attaches the membership as
 * `req.customer`. Platform admins bypass the membership check.
 */
export function requireCustomerRole(roles: Membership['role'][]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const customerId = req.params.id;
    if (req.auth?.isPlatformAdmin) {
      // Platform admins still need the membership shape for downstream code.
      req.customer = {
        customerId, customerName: '', customerStatus: 'active', planId: '',
        planName: '', seatCap: 0, projectCap: -1, telemetryRetentionDays: 365,
        trialEndsAt: null, pastDueSince: null, role: 'owner', membershipStatus: 'active',
      };
      return next();
    }
    const m = membershipIn(req, customerId);
    if (!m) return res.status(403).json({ error: 'Not a member of this customer' });
    if (!roles.includes(m.role)) {
      return res.status(403).json({ error: `Requires role: ${roles.join(' or ')}` });
    }
    req.customer = m;
    next();
  };
}

/** Minimal project shape attached by requireProjectRole. */
export interface RoleCheckedProject {
  id: string;
  customer_id: string | null;
}

/**
 * Where requireProjectRole / requireProjectRead find the project:
 * - `projectParam` — `req.params.id` is the project id (default)
 * - `toolParam` — `req.params.toolId` resolves via the tools table
 * - `reviewItemParam` — `req.params.itemId` resolves via review_items
 * - `releaseParam` — `req.params.releaseId` resolves via releases
 * - `evalRunParam` — `req.params.runId` resolves via eval_runs
 * - `bodyProjectId` — `req.body.project_id` (e.g. POST /v1/runtime/invoke)
 */
export type ProjectRoleSource =
  | 'projectParam'
  | 'toolParam'
  | 'reviewItemParam'
  | 'releaseParam'
  | 'evalRunParam'
  | 'bodyProjectId';

async function resolveProject(source: ProjectRoleSource, req: Request): Promise<RoleCheckedProject | null> {
  switch (source) {
    case 'toolParam':
      return (await one(
        `SELECT p.id, p.customer_id FROM canonical_tools t JOIN projects p ON p.id = t.project_id WHERE t.id = $1`,
        [req.params.toolId],
      )) as RoleCheckedProject | undefined ?? null;
    case 'reviewItemParam':
      return (await one(
        `SELECT p.id, p.customer_id FROM review_items ri JOIN projects p ON p.id = ri.project_id WHERE ri.id = $1`,
        [req.params.itemId],
      )) as RoleCheckedProject | undefined ?? null;
    case 'releaseParam':
      return (await one(
        `SELECT p.id, p.customer_id FROM releases r JOIN projects p ON p.id = r.project_id WHERE r.id = $1`,
        [req.params.releaseId],
      )) as RoleCheckedProject | undefined ?? null;
    case 'evalRunParam':
      return (await one(
        `SELECT p.id, p.customer_id FROM eval_runs er JOIN projects p ON p.id = er.project_id WHERE er.id = $1`,
        [req.params.runId],
      )) as RoleCheckedProject | undefined ?? null;
    case 'bodyProjectId':
      if (!req.body?.project_id) return null;
      return (await one(`SELECT id, customer_id FROM projects WHERE id = $1`, [req.body.project_id])) as
        | RoleCheckedProject
        | undefined ?? null;
    case 'projectParam':
    default:
      return (await one(`SELECT id, customer_id FROM projects WHERE id = $1`, [req.params.id])) as
        | RoleCheckedProject
        | undefined ?? null;
  }
}

/**
 * Middleware factory: require the caller to hold one of `roles` in the customer
 * that owns the project being mutated. Unknown project → 404. No membership,
 * wrong role, or a non-writable customer (trial_expired / suspended) → 403.
 * Platform admins bypass the membership check. Attaches the resolved project
 * as `req.project` and the membership as `req.customer`.
 */
/** Owner-shaped membership attached for platform admins (no real membership). */
function platformAdminCustomer(project: RoleCheckedProject): Membership {
  return {
    customerId: project.customer_id ?? '', customerName: '', customerStatus: 'active', planId: '',
    planName: '', seatCap: 0, projectCap: -1, telemetryRetentionDays: 365,
    trialEndsAt: null, pastDueSince: null, role: 'owner', membershipStatus: 'active',
  };
}

export function requireProjectRole(roles: Membership['role'][], source: ProjectRoleSource = 'projectParam') {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const project = await resolveProject(source, req);
      if (!project) return res.status(404).json({ error: 'Project not found' });
      if (req.auth?.isPlatformAdmin) {
        req.project = project;
        req.customer = platformAdminCustomer(project);
        return next();
      }
      const m = project.customer_id ? membershipIn(req, project.customer_id) : null;
      // No membership reads as 404 so project existence doesn't leak to outsiders.
      if (!m) return res.status(404).json({ error: 'Project not found' });
      if (!roles.includes(m.role)) {
        return res.status(403).json({ error: `Requires role: ${roles.join(' or ')}` });
      }
      if (!customerWritable(m)) {
        return res.status(403).json({ error: `Customer is ${m.customerStatus} — writes are disabled` });
      }
      req.project = project;
      req.customer = m;
      return next();
    } catch (e) {
      return next(e);
    }
  };
}

/** 404 label for a read source — naming the resource the caller asked for. */
function readNotFoundLabel(source: ProjectRoleSource): string {
  if (source === 'releaseParam') return 'Release not found';
  if (source === 'evalRunParam') return 'Eval run not found';
  return 'Project not found';
}

/**
 * BE-09: tenant scoping for project READS. Every project-scoped GET goes
 * through this (mutations use requireProjectRole): a caller may read a
 * project only when they hold ANY membership role (owner/editor/viewer)
 * in the customer that owns it, or they are a platform admin. Unlike the
 * mutation gate there is no role floor and no writable check — read-only
 * customer states (restricted, trial_expired) exist precisely so members
 * can still look, matching the project list/get/export reads.
 *
 * A project with no owning customer is visible to platform admins only.
 *
 * Unknown project AND outsider both answer the same 404, so a project's
 * existence never leaks across accounts.
 */
export function requireProjectRead(source: ProjectRoleSource = 'projectParam') {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const project = await resolveProject(source, req);
      if (!project) return res.status(404).json({ error: readNotFoundLabel(source) });
      req.project = project;
      if (req.auth?.isPlatformAdmin) {
        req.customer = platformAdminCustomer(project);
        return next();
      }
      const m = project.customer_id ? membershipIn(req, project.customer_id) : null;
      if (!m) return res.status(404).json({ error: readNotFoundLabel(source) });
      req.customer = m;
      return next();
    } catch (e) {
      return next(e);
    }
  };
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      customer?: Membership;
      project?: RoleCheckedProject;
    }
  }
}
