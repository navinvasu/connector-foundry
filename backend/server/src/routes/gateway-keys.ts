// Gateway API key control API (DP-07, D-57).
//
// POST   /v1/projects/:id/api-keys            — mint a key (owner/editor)
// GET    /v1/projects/:id/api-keys            — list key metadata (any member)
// POST   /v1/projects/:id/api-keys/:keyId/revoke — soft-revoke (owner/editor)
//
// Security rules (mirroring the AB-02 broker surface):
// - The secret is returned exactly once, in the 201 body. Only its
//   SHA-256 hash and display prefix are ever stored; list/revoke bodies
//   carry metadata only, and the secret never reaches audit metadata or
//   logs (DP-05 also redacts the cf_live_ shape as defense in depth).
// - Revocation is a soft status flip: the row stays as the lifecycle
//   record, the hash can never authenticate again, and repeating the
//   call is a no-op success.
// - Keys are project-scoped: every query is bound to the route's
//   project, and the role gates come from auth.ts (BE-09/BE-13).

import { Router } from 'express';
import { z } from 'zod';
import { validateBody } from '../validate.js';
import { asyncHandler, HttpError } from '../errors.js';
import { one, q, exec, uid, audit } from '../db.js';
import { requireProjectRole, requireProjectRead } from '../auth.js';
import { generateGatewayKeySecret, gatewayKeyPrefix, hashGatewayKey } from '../gateway-keys.js';

export const gatewayKeysRouter = Router();

const keyCreateSchema = z.object({
  label: z.string({ error: 'label is required' }).trim().min(1, 'label is required').max(120, 'label must be at most 120 characters'),
  expires_at: z.string().datetime({ error: 'expires_at must be an ISO 8601 date-time' }).optional(),
});

/** DB row → API metadata. key_hash is NEVER exposed. */
function toMetadata(row: any) {
  return {
    id: row.id,
    project_id: row.project_id,
    label: row.label,
    prefix: row.key_prefix,
    status: row.status,
    created_by: row.created_by ?? null,
    created_at: row.created_at,
    expires_at: row.expires_at ?? null,
    revoked_at: row.revoked_at ?? null,
    last_used_at: row.last_used_at ?? null,
  };
}

const METADATA_COLS = `id, project_id, label, key_prefix, status, created_by, created_at, expires_at, revoked_at, last_used_at`;

// POST /v1/projects/:id/api-keys — mint a key. The 201 is the one and
// only time the secret leaves the server.
gatewayKeysRouter.post('/:id/api-keys',
  requireProjectRole(['owner', 'editor']),
  validateBody(keyCreateSchema),
  asyncHandler(async (req, res) => {
    const projectId = req.params.id;
    const { label, expires_at } = req.body as { label: string; expires_at?: string };
    let expiresAt: Date | null = null;
    if (expires_at !== undefined) {
      expiresAt = new Date(expires_at);
      if (expiresAt <= new Date()) {
        throw new HttpError(400, 'invalid_request', 'expires_at must be in the future');
      }
    }
    const secret = generateGatewayKeySecret();
    const id = uid();
    await exec(
      `INSERT INTO project_api_keys (id, project_id, label, key_prefix, key_hash, status, created_by, expires_at)
       VALUES ($1, $2, $3, $4, $5, 'active', $6, $7)`,
      [id, projectId, label, gatewayKeyPrefix(secret), hashGatewayKey(secret),
        req.auth?.userId ?? null, expiresAt ? expiresAt.toISOString() : null]);
    await audit(projectId, 'gateway_key.created', 'gateway_key', id,
      { label, prefix: gatewayKeyPrefix(secret), expires_at: expiresAt ? expiresAt.toISOString() : null });
    const row = await one(`SELECT ${METADATA_COLS} FROM project_api_keys WHERE id = $1`, [id]);
    res.status(201).json({ ...toMetadata(row), secret });
  }));

// GET /v1/projects/:id/api-keys — metadata list, never secrets. The
// caller's role rides along so the console can hide mutations from
// viewers without a second round-trip (FE-09's rule: UI convenience,
// the API is the gate).
gatewayKeysRouter.get('/:id/api-keys',
  requireProjectRead(),
  asyncHandler(async (req, res) => {
    const list = await q(
      `SELECT ${METADATA_COLS} FROM project_api_keys WHERE project_id = $1 ORDER BY created_at ASC, id ASC`,
      [req.params.id]);
    res.json({
      api_keys: (list as any[]).map(toMetadata),
      caller_role: req.auth?.isPlatformAdmin ? 'owner' : (req.customer?.role ?? null),
    });
  }));

// POST /v1/projects/:id/api-keys/:keyId/revoke — soft revoke. Idempotent:
// revoking twice is a no-op success.
gatewayKeysRouter.post('/:id/api-keys/:keyId/revoke',
  requireProjectRole(['owner', 'editor']),
  asyncHandler(async (req, res) => {
    const projectId = req.params.id;
    const keyId = req.params.keyId;
    const row = await one(`SELECT * FROM project_api_keys WHERE id = $1 AND project_id = $2`,
      [keyId, projectId]) as any;
    if (!row) throw new HttpError(404, 'gateway_key_not_found', 'Gateway key not found');
    if (row.status === 'revoked') {
      return res.json({ ok: true, id: keyId, status: 'revoked' });
    }
    await exec(
      `UPDATE project_api_keys SET status = 'revoked', revoked_at = now()
        WHERE id = $1 AND status = 'active'`,
      [keyId]);
    await audit(projectId, 'gateway_key.revoked', 'gateway_key', keyId,
      { label: row.label, prefix: row.key_prefix });
    res.json({ ok: true, id: keyId, status: 'revoked' });
  }));
