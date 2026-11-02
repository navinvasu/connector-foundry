// Invite accept-link endpoints (SE-10; the email that carries the link is
// BE-14's SES half). Mounted at /v1/invites:
//   GET  /v1/invites/:token         — public: "you've been invited to X"
//   POST /v1/invites/:token/redeem  — authenticated: claim the seat
//
// Unknown, expired, and already-redeemed tokens all answer one generic
// 404 — the endpoints never reveal which of the three happened.

import { Router } from 'express';
import { requireAuth } from '../auth.js';
import { asyncHandler } from '../errors.js';
import { findInviteByToken, inviteExpired, publicInviteInfo, redeemInvite } from '../invites.js';

export const invitesRouter = Router();

const INVALID_INVITE = { error: 'This invite link is invalid or has expired' };

invitesRouter.get('/:token', asyncHandler(async (req, res) => {
  const row = await findInviteByToken(req.params.token);
  if (!row || row.status !== 'invited' || inviteExpired(row)) {
    return res.status(404).json(INVALID_INVITE);
  }
  res.json({ invite: publicInviteInfo(row) });
}));

invitesRouter.post('/:token/redeem', requireAuth, asyncHandler(async (req, res) => {
  const result = await redeemInvite(req.params.token, {
    userId: req.auth!.userId,
    email: req.auth!.email,
  });
  if (!result.ok) {
    if (result.reason === 'email_mismatch') {
      // The caller's own two addresses (BE-14 copy) — not a third-party leak.
      return res.status(403).json({
        error: `You're signed in as ${req.auth!.email}, but this invite was sent to ${result.invited_email}`,
      });
    }
    return res.status(404).json(INVALID_INVITE);
  }
  res.json({
    customer_id: result.customer_id,
    workspace_name: result.workspace_name,
    role: result.role,
  });
}));
