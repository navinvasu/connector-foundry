// Web security basics for the HTTP surface (SE-03): hardening headers on
// every response, and CORS that only trusts an explicit origin allowlist
// outside local development.
//
// Auth here is Bearer-JWT (Cognito), so the server sets NO cookies today;
// the "secure cookies" half of SE-03 is a documented rule for when session
// cookies arrive (FE-01): any cookie must be issued `Secure; HttpOnly;
// SameSite=Lax` (or `Strict`). Nothing to harden until a cookie exists.
//
// Environment contract:
//   CF_CORS_ORIGINS   comma-separated browser origins allowed to call the
//                     API (e.g. "https://console.connectorfoundry.com").
//   NODE_ENV          unset/development → no allowlist means "reflect any
//                     Origin" (local dev: console on :5174 against a
//                     manually-run server). production → no allowlist
//                     means NO browser origin is allowed (fail closed) and
//                     the operator must set CF_CORS_ORIGINS.
//   CF_ORIGIN_SECRET  when set, every request except GET /health must carry
//                     `x-origin-verify: <secret>` — the header CloudFront adds
//                     on its way to the origin (IN-10), so the host can't be
//                     called around the CDN.
//   CF_TRUST_PROXY_HOPS  number of proxies in front (1 behind CloudFront), so
//                     req.ip is the caller and not the edge.
//   CF_PUBLIC_API_BASE_URL  the public API origin used in links the API
//                     hands out (MCP URL, GPT Actions server URL).
import { timingSafeEqual } from 'node:crypto';
import cors, { type CorsOptions } from 'cors';
import type { Express, Request, RequestHandler } from 'express';
import { logger } from './logger.js';

export interface SecurityConfig {
  /** Origins permitted to make browser (CORS) calls; 'any' reflects the
   *  caller's Origin and is only ever produced outside production. */
  corsOrigins: string[] | 'any';
}

/** Parse a comma-separated origin list; empty entries are dropped. */
export function parseOriginList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

export function securityConfigFromEnv(env: NodeJS.ProcessEnv = process.env): SecurityConfig {
  const listed = parseOriginList(env.CF_CORS_ORIGINS);
  if (listed.length > 0) return { corsOrigins: listed };
  return { corsOrigins: env.NODE_ENV === 'production' ? [] : 'any' };
}

/**
 * Headers sent on every API response. This server only ever answers JSON
 * (the console is a separate origin), so the policy is deny-by-default:
 * the response must never be framed, sniffed as another type, cached by a
 * shared cache, or treated as a document by a browser.
 */
export const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'Cross-Origin-Opener-Policy': 'same-origin',
  // API responses are never legitimate subresources for other documents;
  // CORS-mode fetches (the console) are governed by the CORS rules below,
  // not by CORP, so this does not affect the console.
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Referrer-Policy': 'no-referrer',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'X-Content-Type-Options': 'nosniff',
  'X-DNS-Prefetch-Control': 'off',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'Cache-Control': 'no-store',
};

export function securityHeaders(): RequestHandler {
  return (_req, res, next) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      res.setHeader(name, value);
    }
    next();
  };
}

/** Reject requests that did not come through the CDN (CF_ORIGIN_SECRET set). */
export function originVerify(secret: string | undefined): RequestHandler {
  const expected = secret?.trim() ? Buffer.from(secret.trim(), 'utf8') : null;
  return (req, res, next) => {
    if (!expected || (req.method === 'GET' && req.path === '/health')) return next();
    const got = Buffer.from(String(req.headers['x-origin-verify'] ?? ''), 'utf8');
    if (got.length === expected.length && timingSafeEqual(got, expected)) return next();
    res.status(403).json({ error: 'forbidden', message: 'Requests must come through the public endpoint.' });
  };
}

/** Public origin for links the API hands out; the request's own host in local dev. */
export function publicBaseUrl(req: Request, env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.CF_PUBLIC_API_BASE_URL?.trim().replace(/\/+$/, '');
  return configured || `${req.protocol}://${req.get('host')}`;
}

export function corsOptionsFor(config: SecurityConfig): CorsOptions {
  if (config.corsOrigins === 'any') {
    // Dev only: reflect any Origin so a local console just works.
    return { origin: true };
  }
  const allowed = new Set(config.corsOrigins);
  return {
    origin: (origin, cb) => {
      // Non-browser clients (curl, server-to-server, the Stripe webhook)
      // send no Origin — CORS simply does not apply to them.
      if (!origin) return cb(null, true);
      // Unknown origin: proceed WITHOUT CORS headers. The browser then
      // blocks the caller from reading the response — that is the
      // rejection the AC asks for (a 403 here would also break nothing,
      // but no-header is the standard, cache-friendly behavior).
      cb(null, allowed.has(origin));
    },
  };
}

/**
 * Mount the security posture on the app and log what was chosen, so the
 * effective CORS policy is visible in the boot logs rather than implicit.
 * Returns the resolved config (tests assert against it).
 */
export function applySecurity(app: Express, env: NodeJS.ProcessEnv = process.env): SecurityConfig {
  const config = securityConfigFromEnv(env);
  app.disable('x-powered-by');
  const hops = Number(env.CF_TRUST_PROXY_HOPS ?? 0);
  if (Number.isInteger(hops) && hops > 0) app.set('trust proxy', hops);
  app.use(originVerify(env.CF_ORIGIN_SECRET));
  app.use(securityHeaders());
  app.use(cors(corsOptionsFor(config)));
  if (config.corsOrigins === 'any') {
    logger.warn({
      msg: 'cors_reflect_any',
      detail: 'CF_CORS_ORIGINS unset outside production — reflecting any Origin (dev default). Set CF_CORS_ORIGINS before exposing this server.',
    });
  } else if (config.corsOrigins.length === 0) {
    logger.warn({
      msg: 'cors_no_origins',
      detail: 'No browser origins allowed (production without CF_CORS_ORIGINS). Set CF_CORS_ORIGINS to the console origin.',
    });
  }
  return config;
}
