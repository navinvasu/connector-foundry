// BE-07: rate limiting for the data plane (`POST /v1/runtime/invoke`).
// SE-09: the two buckets are charged at different points in the chain.
//
// One abusive caller must not be able to take down invoke for everyone.
// Two independent fixed-window counters gate every invoke:
//   - per client IP (`ip:<addr>`) — charged PRE-authorization (before the
//     project role check). One host hammering many projects is stopped
//     even if it rotates project ids, and a rejected request costs no
//     role-check DB work beyond what auth already did.
//   - per project (`project:<id>`) — charged only AFTER
//     `requireProjectRole` admits the caller for that project (SE-09 /
//     SE-06 F-4). Before this split the project bucket was charged on
//     the attacker-supplied `project_id` before any membership check,
//     so any authenticated trial account could saturate a victim
//     project's 600/min quota while its own requests 404'd at the role
//     gate. Now an outsider's requests never touch the victim's bucket.
// Either bucket tripping rejects with a 429 and the standard error
// envelope ({ error, code: 'rate_limited', request_id }), a
// `Retry-After` header (seconds until the tripped window resets), and
// `X-RateLimit-*` headers naming the tripped bucket's
// limit/remaining/reset. The project middleware runs after the role
// check, so its headers overwrite the IP bucket's on admitted requests
// (the project cap is the tighter, tenant-scoped one).
//
// Design (mirrors DP-06's breaker): in-process fixed windows, no new
// dependency (no express-rate-limit, no Redis — DP-03 owns the shared
// cache when invoke actually needs cross-instance coordination).
// In the DP-01 Lambda split each instance keeps its own counters, so
// the effective fleet-wide cap is limit × instances — acceptable for an
// abuse guard (API Gateway throttling, DP-02, is the hard edge limit);
// the caps are deliberately set as per-instance safety valves.
// The clock is injectable so the window math is unit-testable without
// real waits, and expired buckets are swept opportunistically so the
// map can't grow unboundedly under IP churn.

import type { NextFunction, Request, Response } from 'express';

function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** Invokes allowed per project per window. Read per request so ops/tests can tune it. */
export function resolveProjectRateLimit(): { limit: number; windowMs: number } {
  return {
    limit: envInt('CF_INVOKE_RATE_LIMIT_PER_PROJECT', 600),
    windowMs: envInt('CF_INVOKE_RATE_WINDOW_MS', 60_000),
  };
}

/** Invokes allowed per client IP per window. Read per request so ops/tests can tune it. */
export function resolveIpRateLimit(): { limit: number; windowMs: number } {
  return {
    limit: envInt('CF_INVOKE_RATE_LIMIT_PER_IP', 1200),
    windowMs: envInt('CF_INVOKE_RATE_WINDOW_MS', 60_000),
  };
}

export interface RateLimitDecision {
  allowed: boolean;
  /** The bucket that decided: 'project' | 'ip' | 'key' (the tripped one when denied). */
  bucket: 'project' | 'ip' | 'key';
  limit: number;
  /** Requests left in the deciding bucket's current window (0 when denied). */
  remaining: number;
  /** Epoch ms when the deciding bucket's window resets. */
  reset_at: number;
  /** Milliseconds until reset — ceil to seconds for `Retry-After`. */
  retry_after_ms: number;
}

interface Bucket {
  windowStart: number;
  count: number;
}

/**
 * Fixed-window limiter over named buckets. One instance holds both the
 * project and IP buckets (keys are namespaced by the caller).
 */
export class FixedWindowRateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  /**
   * Count one hit against `key` and decide. An expired window restarts
   * at this hit. Denied hits still count (a hammering client keeps its
   * own window full instead of probing for the reset edge for free).
   */
  check(key: string, limit: number, windowMs: number): Omit<RateLimitDecision, 'bucket'> {
    const t = this.now();
    this.sweep(t, windowMs);
    let b = this.buckets.get(key);
    if (!b || t - b.windowStart >= windowMs) {
      b = { windowStart: t, count: 0 };
      this.buckets.set(key, b);
    }
    b.count += 1;
    const reset_at = b.windowStart + windowMs;
    const allowed = b.count <= limit;
    return {
      allowed,
      limit,
      remaining: allowed ? limit - b.count : 0,
      reset_at,
      retry_after_ms: allowed ? 0 : Math.max(0, reset_at - t),
    };
  }

  /** Drop buckets whose windows have fully expired (memory bound). */
  private sweep(t: number, windowMs: number): void {
    // Cheap opportunistic sweep: only when the map is non-trivial.
    if (this.buckets.size < 1024) return;
    for (const [k, b] of this.buckets) {
      if (t - b.windowStart >= windowMs) this.buckets.delete(k);
    }
  }

  /** Test hook / introspection: live bucket count. */
  get size(): number {
    return this.buckets.size;
  }

  /** Test hook: drop all buckets so cases start from a clean slate. */
  reset(): void {
    this.buckets.clear();
  }
}

// One process-wide limiter for the data plane (DP-01 note above applies).
const invokeLimiter = new FixedWindowRateLimiter();

/** Test hook: clear the process-wide limiter's buckets. */
export function resetInvokeRateLimiter(): void {
  invokeLimiter.reset();
}

/** The client IP for rate limiting: Express's `req.ip` (proxy-aware via
 *  `trust proxy` when deployed behind a gateway); 'unknown' when absent —
 *  unidentifiable clients share one conservative bucket rather than
 *  bypassing the IP limit entirely. */
export function clientIpOf(req: Request): string {
  return req.ip ?? 'unknown';
}

/** Charge only the per-IP bucket (SE-09 pre-authorization gate). */
export function checkIpRateLimit(
  clientIp: string,
  limiter: FixedWindowRateLimiter = invokeLimiter,
): RateLimitDecision {
  const ipCfg = resolveIpRateLimit();
  const i = limiter.check(`ip:${clientIp}`, ipCfg.limit, ipCfg.windowMs);
  return { ...i, bucket: 'ip' };
}

/** Charge only the per-project bucket (SE-09 post-authorization gate). */
export function checkProjectRateLimit(
  projectId: string,
  limiter: FixedWindowRateLimiter = invokeLimiter,
): RateLimitDecision {
  const proj = resolveProjectRateLimit();
  const p = limiter.check(`project:${projectId}`, proj.limit, proj.windowMs);
  return { ...p, bucket: 'project' };
}

/**
 * DP-07: charge the per-key bucket for a gateway-key invoke. The bucket
 * type is 'key' (the decision still reports limit/remaining/reset like
 * the other buckets). One leaked or abusive key can be throttled without
 * touching the project's other callers beyond the shared project bucket,
 * which is charged separately as before.
 */
export function checkKeyRateLimit(
  keyId: string,
  limiter: FixedWindowRateLimiter = invokeLimiter,
): RateLimitDecision {
  const proj = resolveProjectRateLimit();
  const p = limiter.check(`key:${keyId}`, proj.limit, proj.windowMs);
  return { ...p, bucket: 'key' as RateLimitDecision['bucket'] };
}

/**
 * Check both buckets for one invoke. The project bucket is checked first
 * (the tighter, tenant-scoped cap); the IP bucket only counts the hit
 * when the project bucket admits it, so one abusive project can't burn
 * a shared NAT IP's allowance for the other tenants behind it.
 *
 * This combined check remains the gate for direct `invoke()` callers
 * (no HTTP role check has run on that path — `runtime.ts`). The HTTP
 * route no longer uses it pre-authorization: it charges the IP bucket
 * via `checkIpRateLimit` before the role check and the project bucket
 * via `checkProjectRateLimit` after it (SE-09).
 */
export function checkInvokeRateLimit(
  projectId: string,
  clientIp: string,
  limiter: FixedWindowRateLimiter = invokeLimiter,
): RateLimitDecision {
  const proj = resolveProjectRateLimit();
  const p = limiter.check(`project:${projectId}`, proj.limit, proj.windowMs);
  if (!p.allowed) return { ...p, bucket: 'project' };
  const ipCfg = resolveIpRateLimit();
  const i = limiter.check(`ip:${clientIp}`, ipCfg.limit, ipCfg.windowMs);
  if (!i.allowed) return { ...i, bucket: 'ip' };
  // Admitted: report the tighter of the two buckets' remaining headroom.
  return i.remaining < p.remaining ? { ...i, bucket: 'ip' } : { ...p, bucket: 'project' };
}

function applyRateHeaders(res: Response, d: RateLimitDecision): void {
  res.setHeader('X-RateLimit-Limit', String(d.limit));
  res.setHeader('X-RateLimit-Remaining', String(d.remaining));
  res.setHeader('X-RateLimit-Reset', String(Math.ceil(d.reset_at / 1000)));
  if (!d.allowed) {
    res.setHeader('Retry-After', String(Math.max(1, Math.ceil(d.retry_after_ms / 1000))));
  }
}

function sendRateLimited(req: Request, res: Response, decision: RateLimitDecision): void {
  applyRateHeaders(res, decision);
  const scope = decision.bucket === 'project' ? 'project' : decision.bucket === 'key' ? 'API key' : 'client';
  res.status(429).json({
    error: `Rate limit exceeded for this ${scope} — try again after the current window resets.`,
    code: 'rate_limited',
    request_id: req.id ?? null,
    rate_limit: {
      bucket: decision.bucket,
      limit: decision.limit,
      remaining: decision.remaining,
      reset_at: new Date(decision.reset_at).toISOString(),
      retry_after_seconds: Math.max(1, Math.ceil(decision.retry_after_ms / 1000)),
    },
  });
}

/**
 * SE-09 pre-authorization middleware for `POST /v1/runtime/invoke`:
 * mount BEFORE `requireProjectRole`. Charges ONLY the per-IP bucket —
 * the project bucket is not touched here, so naming a victim project
 * costs the victim nothing. Every invoke attempt counts toward the
 * caller's IP window (the IP does not depend on a trustworthy
 * `project_id`, so malformed bodies are charged too and fall through
 * to the role gate / validation when admitted). A tripped IP bucket
 * rejects before any role-check DB work.
 */
export function invokeIpRateLimit(req: Request, res: Response, next: NextFunction): void {
  const decision = checkIpRateLimit(clientIpOf(req));
  applyRateHeaders(res, decision);
  if (decision.allowed) return next();
  sendRateLimited(req, res, decision);
}

/**
 * SE-09 post-authorization middleware for `POST /v1/runtime/invoke`:
 * mount AFTER `requireProjectRole` (which 404s outsiders and attaches
 * `req.project`). Charges ONLY the per-project bucket, keyed on the
 * role-checked project (`req.project.id`), never on the raw
 * attacker-supplied body value. Requests the role gate rejected never
 * reach this middleware, so they never burn the project's quota.
 * Falls through uncharged when no project was resolved (the role gate
 * or validation answers those requests as before).
 */
export function invokeProjectRateLimit(req: Request, res: Response, next: NextFunction): void {
  const projectId = req.project?.id
    ?? (typeof req.body?.project_id === 'string' ? req.body.project_id : '');
  if (!projectId) return next();
  const decision = checkProjectRateLimit(projectId);
  applyRateHeaders(res, decision);
  if (decision.allowed) return next();
  sendRateLimited(req, res, decision);
}

/**
 * DP-07 post-authorization middleware for gateway-key invokes: charges
 * ONLY the per-key bucket, keyed on the authenticated key (`req.gatewayKey`).
 * Human invokes (no gateway key on the request) pass through uncharged —
 * their buckets are the IP + project pair as before.
 */
export function invokeKeyRateLimit(req: Request, res: Response, next: NextFunction): void {
  const key = (req as any).gatewayKey as { id: string } | undefined;
  if (!key?.id) return next();
  const decision = checkKeyRateLimit(key.id);
  applyRateHeaders(res, decision);
  if (decision.allowed) return next();
  sendRateLimited(req, res, decision);
}

/**
 * @deprecated Pre-SE-09 combined gate: it charged the per-project
 * bucket before authorization (SE-06 F-4). Retained only as an alias
 * of the safe pre-authorization half so a stale mount degrades to
 * IP-only limiting instead of reintroducing the cross-tenant wedge.
 * New code uses `invokeIpRateLimit` + `invokeProjectRateLimit`.
 */
export const invokeRateLimit = invokeIpRateLimit;
