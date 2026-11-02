// Lease resolution (AB-02) — the broker's internal contract, shaped so the
// DP-01 Lambda split can turn it into POST /internal/credential-leases
// without changing callers (AB-01).
//
// resolveLease({ tenant, projectId, scopes, purpose }) →
//   { ok: true, material } | { ok: false, reason: 'credential_missing' }
//
// Rules:
// - Server-side selection only: the request never names a handle. The
//   tenant comes from the server's own project lookup, never caller input
//   (confused-deputy defense; tenant A's credential is unresolvable from
//   tenant B's context — the JOIN enforces it, not the caller).
// - v1 serves api_key tools only (D-31). OAuth tools never reach this
//   function — their refusal lives in runtime.ts/eval.ts (AB-05, unchanged).
// - The material is returned to the caller's memory only; it is never
//   logged, never persisted, never placed in audit metadata.
// - Denial is silent about WHY (missing vs. wrong tenant): both read as
//   'credential_missing' so existence doesn't leak across tenants.
// - Per-invoke lease grants are NOT audit rows (D-36): the invoke path
//   already audits runtime.invoke.* per call; explicit audit rows are
//   written for capture/rotate/revoke lifecycle events only.

import { one } from '../db.js';
import { requireVault } from './vault.js';

/** Tombstone written into vault_handle on revoke — crypto-erases the envelope in place. */
export const DESTROYED_HANDLE = 'destroyed';

export interface LeaseRequest {
  /** Owning customer id, from the server's project lookup — never caller input. Null for legacy customer-less projects. */
  tenant: string | null;
  projectId: string;
  /** Reserved for AB-03 scope checks; api_key tools carry no scopes. */
  scopes: string[];
  /** Stated purpose, bound into the vault read ('invoke' | 'eval-probe'). */
  purpose: 'invoke' | 'eval-probe';
}

export type LeaseResult =
  | { ok: true; material: string }
  | { ok: false; reason: 'credential_missing' };

/** Server-side tenant lookup for a project (control-plane read). */
export async function resolveProjectTenant(projectId: string): Promise<string | null> {
  const row = await one(`SELECT customer_id FROM projects WHERE id = $1`, [projectId]) as any;
  return (row?.customer_id as string | null) ?? null;
}

export async function resolveLease(req: LeaseRequest): Promise<LeaseResult> {
  const row = await one(
    `SELECT c.vault_handle AS vault_handle
       FROM project_credentials c
       JOIN projects p ON p.id = c.project_id
      WHERE c.project_id = $1
        AND c.kind = 'api_key'
        AND c.status = 'active'
        AND (p.customer_id = $2 OR (p.customer_id IS NULL AND $2 IS NULL))`,
    [req.projectId, req.tenant]) as { vault_handle?: string } | undefined;
  const handle = row?.vault_handle;
  if (!handle || handle === DESTROYED_HANDLE) {
    return { ok: false, reason: 'credential_missing' };
  }
  // 503 credential_storage_not_configured when no KMS/dev vault is set
  // (a row without a configured vault cannot be decrypted — fail closed).
  const vault = requireVault();
  const material = await vault.readForPurpose(handle, req.purpose);
  return { ok: true, material };
}
