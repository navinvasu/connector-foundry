// Credential broker control API (AB-02).
//
// POST   /v1/projects/:id/credentials            — capture an API key (owner/editor)
// GET    /v1/projects/:id/credentials            — list credential metadata (any member)
// POST   /v1/projects/:id/credentials/:credId/rotate — replace material (owner/editor)
// POST   /v1/projects/:id/credentials/:credId/revoke — revoke (owner/editor)
//
// Security rules (AB-01):
// - The cleartext `value` is written to the vault and NEVER returned,
//   logged, echoed, or placed in audit metadata. 201/200 bodies carry
//   metadata only (id, label, fingerprint, status, timestamps).
// - Until a vault is configured (CF_BROKER_KMS_KEY_ID / CF_BROKER_DEV_KEY),
//   every mutation 503s `credential_storage_not_configured` (BL-01 pattern).
// - One active credential per (project, kind) — the partial unique index
//   is the backstop; concurrent captures map the 23505 violation to 409.
// - Handles are server-side only: rotate/revoke address credentials by id
//   within the project; callers never name a vault handle.

import { Router } from 'express';
import { z } from 'zod';
import { validateBody } from '../validate.js';
import { asyncHandler, HttpError } from '../errors.js';
import { one, q, exec, uid, audit } from '../db.js';
import { requireProjectRole, requireProjectRead } from '../auth.js';
import { requireVault, DESTROYED_HANDLE } from '../broker/index.js';
import { logger } from '../logger.js';

export const credentialsRouter = Router();

const credentialCaptureSchema = z.object({
  label: z.string({ error: 'label is required' }).trim().min(1, 'label is required').max(120, 'label must be at most 120 characters'),
  // API keys are short; the cap rejects accidental pastes of whole files.
  value: z.string({ error: 'value is required' }).min(1, 'value is required').max(4096, 'value must be at most 4096 characters'),
});

const credentialRotateSchema = z.object({
  value: z.string({ error: 'value is required' }).min(1, 'value is required').max(4096, 'value must be at most 4096 characters'),
});

/** DB row → API metadata. vault_handle is NEVER exposed. */
function toMetadata(row: any) {
  return {
    id: row.id,
    project_id: row.project_id,
    label: row.label,
    kind: row.kind,
    fingerprint: row.key_fingerprint,
    status: row.status,
    created_by: row.created_by ?? null,
    created_at: row.created_at,
    rotated_at: row.rotated_at ?? null,
    revoked_at: row.revoked_at ?? null,
  };
}

const METADATA_COLS = `id, project_id, label, kind, key_fingerprint, status, created_by, created_at, rotated_at, revoked_at`;

// POST /v1/projects/:id/credentials — capture a new API key for the project.
credentialsRouter.post('/:id/credentials',
  requireProjectRole(['owner', 'editor']),
  validateBody(credentialCaptureSchema),
  asyncHandler(async (req, res) => {
    // 503 before any DB write when no vault is configured.
    const vault = requireVault();
    const projectId = req.params.id;
    const { label, value } = req.body as { label: string; value: string };

    const existing = await one(
      `SELECT id FROM project_credentials WHERE project_id = $1 AND kind = 'api_key' AND status = 'active'`,
      [projectId]);
    if (existing) {
      throw new HttpError(409, 'credential_already_configured',
        'This project already has an active API key. Rotate it to replace the material.');
    }

    // The value goes to the vault here and is never referenced again —
    // not in the response, not in audit metadata, not in logs.
    const { handle, fingerprint } = await vault.put(value);
    const id = uid();
    try {
      await exec(
        `INSERT INTO project_credentials (id, project_id, label, kind, vault_handle, key_fingerprint, status, created_by)
         VALUES ($1, $2, $3, 'api_key', $4, $5, 'active', $6)`,
        [id, projectId, label, handle, fingerprint, req.auth?.userId ?? null]);
    } catch (e: any) {
      // Lost a concurrent capture race — the index is the atomic backstop.
      if (e?.code === '23505') {
        throw new HttpError(409, 'credential_already_configured',
          'This project already has an active API key. Rotate it to replace the material.');
      }
      throw e;
    }
    await audit(projectId, 'credential.captured', 'credential', id,
      { label, kind: 'api_key', fingerprint });
    const row = await one(`SELECT ${METADATA_COLS} FROM project_credentials WHERE id = $1`, [id]);
    res.status(201).json(toMetadata(row));
  }));

// GET /v1/projects/:id/credentials — metadata list, never values.
credentialsRouter.get('/:id/credentials',
  requireProjectRead(),
  asyncHandler(async (req, res) => {
    const list = await q(
      `SELECT ${METADATA_COLS} FROM project_credentials WHERE project_id = $1 ORDER BY created_at ASC, id ASC`,
      [req.params.id]);
    res.json({ credentials: (list as any[]).map(toMetadata) });
  }));

// POST /v1/projects/:id/credentials/:credId/rotate — atomic handle swap.
credentialsRouter.post('/:id/credentials/:credId/rotate',
  requireProjectRole(['owner', 'editor']),
  validateBody(credentialRotateSchema),
  asyncHandler(async (req, res) => {
    const vault = requireVault();
    const projectId = req.params.id;
    const credId = req.params.credId;
    const row = await one(`SELECT * FROM project_credentials WHERE id = $1 AND project_id = $2`,
      [credId, projectId]) as any;
    if (!row || row.status !== 'active') {
      throw new HttpError(404, 'credential_not_found', 'Credential not found');
    }

    const { value } = req.body as { value: string };
    const { handle, fingerprint } = await vault.put(value);
    const oldHandle: string = row.vault_handle;
    // Atomic swap: one UPDATE replaces the envelope. The old material is
    // unreferenced from this point on (simplified rotation for keys —
    // no grace window, per the AB-01 design).
    await exec(
      `UPDATE project_credentials SET vault_handle = $1, key_fingerprint = $2, rotated_at = now()
        WHERE id = $3 AND status = 'active'`,
      [handle, fingerprint, credId]);
    try {
      await vault.destroy(oldHandle);
    } catch (e) {
      // The swap already committed; a destroy-validation failure must not
      // 500 a successful rotation. The old envelope is unreferenced.
      logger.warn({ msg: 'credential rotate: old handle destroy failed', credential_id: credId,
        error: e instanceof Error ? e.message : String(e) });
    }
    await audit(projectId, 'credential.rotated', 'credential', credId,
      { label: row.label, kind: 'api_key', fingerprint });
    const updated = await one(`SELECT ${METADATA_COLS} FROM project_credentials WHERE id = $1`, [credId]);
    res.json(toMetadata(updated));
  }));

// POST /v1/projects/:id/credentials/:credId/revoke — status flip +
// in-place crypto-erasure of the envelope + audit tombstone. Idempotent:
// revoking twice is a no-op success.
credentialsRouter.post('/:id/credentials/:credId/revoke',
  requireProjectRole(['owner', 'editor']),
  asyncHandler(async (req, res) => {
    const vault = requireVault();
    const projectId = req.params.id;
    const credId = req.params.credId;
    const row = await one(`SELECT * FROM project_credentials WHERE id = $1 AND project_id = $2`,
      [credId, projectId]) as any;
    if (!row) throw new HttpError(404, 'credential_not_found', 'Credential not found');
    if (row.status === 'revoked') {
      return res.json({ ok: true, id: credId, status: 'revoked' });
    }
    try {
      await vault.destroy(row.vault_handle);
    } catch (e) {
      // The tombstone UPDATE below is the real erasure; a destroy-validation
      // failure must not 500 a revocation.
      logger.warn({ msg: 'credential revoke: old handle destroy failed', credential_id: credId,
        error: e instanceof Error ? e.message : String(e) });
    }
    // Erasure: the envelope is replaced by the tombstone in the same row —
    // no cleartext, no ciphertext, no wrapped key remains.
    await exec(
      `UPDATE project_credentials SET status = 'revoked', revoked_at = now(), vault_handle = $1
        WHERE id = $2 AND status = 'active'`,
      [DESTROYED_HANDLE, credId]);
    await audit(projectId, 'credential.revoked', 'credential', credId,
      { label: row.label, kind: 'api_key', fingerprint: row.key_fingerprint });
    res.json({ ok: true, id: credId, status: 'revoked' });
  }));
