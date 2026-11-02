// Invite token redemption (SE-10, SE-06 F-5; pairs with BE-14).
//
// An invite token is a bearer credential for one invited seat, so it gets
// credential handling, not session handling:
//   - Only the SHA-256 hash is ever stored (migration 012); the plaintext
//     exists solely in the invite email and in the invite API's
//     create/re-invite response, shown once to the inviter.
//   - Lookup is by hash, and the stored hash is re-compared with
//     timingSafeEqual as defense in depth.
//   - Redemption is token-checked (this module), binds the signed-in
//     user's email to the invited email, and burns the token on use —
//     replay answers the same generic 404 as an unknown token, so the
//     endpoints are no oracle for which tokens ever existed.
//
// Until SE-10, acceptance was FE-08's email-match-on-sign-in; that stays
// only as the fallback for legacy rows carrying no token hash (see
// acceptPendingInvites in auth.ts). Every invite minted now has a hash
// and can be accepted solely by redeeming its token here.

import { createHash, timingSafeEqual } from 'node:crypto';
import { one, exec } from './db.js';

/** SHA-256 hex of the plaintext token — the only form ever persisted. */
export function hashInviteToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Constant-time check of a candidate token against a stored hash. */
export function inviteHashMatches(storedHash: string | null | undefined, token: string): boolean {
  if (!storedHash || !token) return false;
  const computed = Buffer.from(hashInviteToken(token), 'utf8');
  const stored = Buffer.from(String(storedHash), 'utf8');
  if (computed.length !== stored.length) return false;
  return timingSafeEqual(computed, stored);
}

export interface InviteRow {
  membership_id: string;
  customer_id: string;
  workspace_name: string;
  role: 'owner' | 'editor' | 'viewer';
  status: string;
  invite_expires_at: string | null;
  invite_token_hash: string | null;
  invited_email: string;
  inviter_name: string | null;
  inviter_email: string | null;
}

const INVITE_SELECT = `
  SELECT cu.id AS membership_id, cu.customer_id, c.name AS workspace_name,
         cu.role, cu.status, cu.invite_expires_at, cu.invite_token_hash,
         u.email AS invited_email,
         inv.full_name AS inviter_name, inv.email AS inviter_email
    FROM customer_users cu
    JOIN customers c ON c.id = cu.customer_id
    JOIN users u ON u.id = cu.user_id
    LEFT JOIN users inv ON inv.id = cu.invited_by`;

/** Find the pending invite a plaintext token points at, or null. */
export async function findInviteByToken(token: string): Promise<InviteRow | null> {
  if (!token || token.length > 256) return null;
  const row = (await one<any>(`${INVITE_SELECT} WHERE cu.invite_token_hash = $1`, [
    hashInviteToken(token),
  ])) as InviteRow | undefined;
  if (!row) return null;
  // The lookup already matched on the hash; re-compare in constant time so
  // the acceptance check never rests on a bare string equality.
  if (!inviteHashMatches(row.invite_token_hash, token)) return null;
  return row;
}

/** An invite with no expiry never expires (defensive: minted invites always set one). */
export function inviteExpired(row: InviteRow, now: Date = new Date()): boolean {
  return row.invite_expires_at != null && new Date(row.invite_expires_at) <= now;
}

/** The info a logged-out invitee may see: enough to recognise the invite, no roster, no emails. */
export function publicInviteInfo(row: InviteRow) {
  return {
    workspace_name: row.workspace_name,
    inviter_name: row.inviter_name ?? row.inviter_email,
    role: row.role,
    expires_at: row.invite_expires_at,
    status: row.status,
  };
}

export type RedeemResult =
  | { ok: true; customer_id: string; workspace_name: string; role: InviteRow['role'] }
  | { ok: false; reason: 'invalid' }
  | { ok: false; reason: 'email_mismatch'; invited_email: string };

/**
 * Redeem `token` for the signed-in user. Only a live (`invited`, unexpired)
 * invite can redeem, only for the email it was sent to, and exactly once —
 * the UPDATE is conditional on the row still being `invited`, so a replay
 * (or a lost race) burns to the generic invalid answer.
 */
export async function redeemInvite(
  token: string,
  user: { userId: string; email: string },
): Promise<RedeemResult> {
  const row = await findInviteByToken(token);
  if (!row || row.status !== 'invited' || inviteExpired(row)) return { ok: false, reason: 'invalid' };
  if (row.invited_email.toLowerCase() !== user.email.toLowerCase()) {
    return { ok: false, reason: 'email_mismatch', invited_email: row.invited_email };
  }
  const n = await exec(
    `UPDATE customer_users
        SET status = 'active', joined_at = COALESCE(joined_at, now()),
            invite_token_hash = NULL, invite_expires_at = NULL
      WHERE id = $1 AND user_id = $2 AND status = 'invited'`,
    [row.membership_id, user.userId],
  );
  if (n === 0) return { ok: false, reason: 'invalid' };
  return { ok: true, customer_id: row.customer_id, workspace_name: row.workspace_name, role: row.role };
}
