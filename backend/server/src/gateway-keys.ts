// Gateway API keys (DP-07, D-57): project-scoped consumer credentials for
// the data plane. Scripts, MCP clients, and GPT Actions invoke a project's
// released connector with the key instead of a human's Cognito JWT:
//
//   Authorization: Bearer <redacted>
//   X-API-Key: <redacted>          (same secret, both honored — D-57)
//
// Credential handling mirrors the invite tokens (SE-10) and the credential
// broker (AB-02):
//   - Only the SHA-256 hash is ever stored (migration 013); the secret
//     exists solely in the create response (shown once) and in the
//     caller's hands. The display prefix (`cf_live_` + 8 chars) is the
//     only key material that may appear in telemetry, audit, or logs.
//   - Lookup is by hash, re-compared with timingSafeEqual as defense in
//     depth; unknown / expired / revoked keys all answer one generic 401,
//     and a key presented for another project answers 404 so a project's
//     existence never leaks (BE-09 rule).
//   - Revocation is soft (status flip); an expired or revoked hash can
//     never authenticate again.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { one, exec } from './db.js';

export const GATEWAY_KEY_PREFIX = 'cf_live_';

/** A presented value is a candidate gateway key only if it carries the prefix. */
export function isGatewayKey(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.startsWith(GATEWAY_KEY_PREFIX);
}

/** Mint a fresh secret: `cf_live_` + 32 base64url chars (192 bits). */
export function generateGatewayKeySecret(): string {
  return GATEWAY_KEY_PREFIX + randomBytes(24).toString('base64url');
}

/** Display-safe head of the secret: `cf_live_` + 8 chars. Never sensitive. */
export function gatewayKeyPrefix(secret: string): string {
  return secret.slice(0, GATEWAY_KEY_PREFIX.length + 8);
}

/** SHA-256 hex of the full secret — the only form ever persisted. */
export function hashGatewayKey(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

/** Constant-time check of a candidate secret against a stored hash. */
export function gatewayHashMatches(storedHash: string | null | undefined, secret: string): boolean {
  if (!storedHash || !secret) return false;
  const computed = Buffer.from(hashGatewayKey(secret), 'utf8');
  const stored = Buffer.from(String(storedHash), 'utf8');
  if (computed.length !== stored.length) return false;
  return timingSafeEqual(computed, stored);
}

/**
 * Extract the presented gateway key from a request, or null when the
 * caller didn't present one (the human JWT path). Both headers carry the
 * same secret; when both are present the Bearer value wins.
 */
export function extractGatewayKey(headers: Record<string, string | string[] | undefined>): string | null {
  const auth = headers.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    const token = auth.slice(7).trim();
    if (isGatewayKey(token)) return token;
  }
  const apiKey = headers['x-api-key'];
  if (typeof apiKey === 'string' && isGatewayKey(apiKey.trim())) return apiKey.trim();
  return null;
}

export interface GatewayKeyRow {
  id: string;
  project_id: string;
  label: string;
  key_prefix: string;
  key_hash: string;
  status: 'active' | 'revoked';
  expires_at: string | null;
  customer_status: string | null;
}

/**
 * Authenticate a presented secret. Resolves to the key row (joined with
 * the owning project's customer status for the writable check) or null
 * for unknown / revoked / expired — callers answer all three with the
 * same generic 401. The constant-time re-compare means acceptance never
 * rests on a bare string equality.
 */
export async function authenticateGatewayKey(secret: string): Promise<GatewayKeyRow | null> {
  if (!isGatewayKey(secret) || secret.length > 128) return null;
  const row = (await one<any>(
    `SELECT k.id, k.project_id, k.label, k.key_prefix, k.key_hash, k.status, k.expires_at,
            c.status AS customer_status
       FROM project_api_keys k
       JOIN projects p ON p.id = k.project_id
       LEFT JOIN customers c ON c.id = p.customer_id
      WHERE k.key_hash = $1`,
    [hashGatewayKey(secret)],
  )) as GatewayKeyRow | undefined;
  if (!row) return null;
  if (!gatewayHashMatches(row.key_hash, secret)) return null;
  if (row.status !== 'active') return null;
  if (row.expires_at != null && new Date(row.expires_at) <= new Date()) return null;
  return row;
}

/** Stamp last use. Best-effort: a failed stamp never fails the invoke. */
export async function touchGatewayKey(keyId: string): Promise<void> {
  try {
    await exec(`UPDATE project_api_keys SET last_used_at = now() WHERE id = $1`, [keyId]);
  } catch { /* telemetry still records the invoke; the stamp is cosmetic */ }
}

/** The telemetry/audit actor for a key invoke: prefix only, never material. */
export function gatewayActor(row: Pick<GatewayKeyRow, 'key_prefix'>): string {
  return `api-key:${row.key_prefix}`;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** DP-07: set by the invoke auth dispatcher when a gateway key authenticated. */
      gatewayKey?: GatewayKeyRow;
    }
  }
}
