// Credential vault (AB-02) — KMS-envelope encryption for API-key material.
//
// Security contract (AB-01 Phase 1, D-30):
// - The cleartext key NEVER lands in Postgres, logs, telemetry, job
//   payloads, audit metadata, or error bodies. Only the opaque envelope
//   handle (ciphertext + wrapped data key) is persisted.
// - Per-credential data key (AES-256-GCM), wrapped by a key-encryption key
//   (KEK). Two KEK providers:
//     * KMS  — CF_BROKER_KMS_KEY_ID set (production; real AWS KMS via
//              @aws-sdk/client-kms, us-east-1 per PF-10). Arrives with IN-01.
//     * DEV  — CF_BROKER_DEV_KEY set (local dev / tests only). A 32-byte
//              hex/base64 key used as a local KEK. REJECTED AT BOOT in
//              production (assertBrokerBoot) — a dev KEK in prod would be a
//              silent downgrade of the whole vault.
// - Until either is set, every broker mutation 503s with
//   `credential_storage_not_configured` (BL-01/EV-03 env-gating pattern).
//
// The envelope is SELF-CONTAINED: the vault_handle stored in
// project_credentials IS the envelope (wrapped key + IV + ciphertext), so
// no separate vault table is needed and revocation crypto-erases by
// tombstoning the handle in the row. The put/readForPurpose/destroy
// interface stays identical if a future store (e.g. Secrets Manager)
// replaces the envelope-in-Postgres layout.

import { randomBytes, createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import { HttpError } from '../errors.js';

const HANDLE_PREFIX = 'cfv1.';
const DATA_KEY_BYTES = 32;

/** Key-encryption-key provider: wraps/unwraps per-credential data keys. */
export interface KekProvider {
  wrapKey(dataKey: Buffer): Promise<Buffer>;
  unwrapKey(wrapped: Buffer): Promise<Buffer>;
  /** Non-secret label for logs/diagnostics (e.g. 'dev' or 'kms:<key-id>'). */
  describe(): string;
}

/** Local KEK for dev/tests: AES-256-GCM with a caller-supplied 32-byte key. */
export class DevKekProvider implements KekProvider {
  private readonly kek: Buffer;

  constructor(rawKey: string) {
    const hex = /^[0-9a-fA-F]{64}$/.test(rawKey.trim());
    const b64 = /^[A-Za-z0-9+/]{43}=$/.test(rawKey.trim());
    const kek = hex
      ? Buffer.from(rawKey.trim(), 'hex')
      : b64 ? Buffer.from(rawKey.trim(), 'base64') : null;
    if (!kek || kek.length !== DATA_KEY_BYTES) {
      throw new Error('CF_BROKER_DEV_KEY must be 32 bytes as hex (64 chars) or base64 (44 chars)');
    }
    this.kek = kek;
  }

  describe(): string { return 'dev'; }

  async wrapKey(dataKey: Buffer): Promise<Buffer> {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.kek, iv);
    const ct = Buffer.concat([cipher.update(dataKey), cipher.final()]);
    // iv || tag || ciphertext — fixed layout, tag always 16 bytes.
    return Buffer.concat([iv, cipher.getAuthTag(), ct]);
  }

  async unwrapKey(wrapped: Buffer): Promise<Buffer> {
    if (wrapped.length < 12 + 16 + DATA_KEY_BYTES) throw new Error('malformed wrapped key');
    const iv = wrapped.subarray(0, 12);
    const tag = wrapped.subarray(12, 28);
    const ct = wrapped.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', this.kek, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  }
}

/** Production KEK: AWS KMS Encrypt/Decrypt of the data key (D-30). */
export class KmsKekProvider implements KekProvider {
  private readonly keyId: string;
  private readonly region: string;

  constructor(keyId: string, region = process.env.AWS_REGION ?? 'us-east-1') {
    this.keyId = keyId;
    this.region = region;
  }

  describe(): string { return `kms:${this.keyId}`; }

  private async sdk(): Promise<any> {
    try {
      return await import('@aws-sdk/client-kms');
    } catch {
      throw new HttpError(503, 'credential_storage_not_configured',
        'Credential storage is not configured: the KMS client library is unavailable.');
    }
  }

  async wrapKey(dataKey: Buffer): Promise<Buffer> {
    const mod = await this.sdk();
    const kms = new mod.KMSClient({ region: this.region });
    const out = await kms.send(new mod.EncryptCommand({ KeyId: this.keyId, Plaintext: dataKey }));
    if (!out.CiphertextBlob) throw new Error('KMS Encrypt returned no ciphertext');
    return Buffer.from(out.CiphertextBlob);
  }

  async unwrapKey(wrapped: Buffer): Promise<Buffer> {
    const mod = await this.sdk();
    const kms = new mod.KMSClient({ region: this.region });
    const out = await kms.send(new mod.DecryptCommand({ KeyId: this.keyId, CiphertextBlob: wrapped }));
    if (!out.Plaintext) throw new Error('KMS Decrypt returned no plaintext');
    return Buffer.from(out.Plaintext);
  }
}

interface Envelope {
  v: 1;
  kek: string;
  wk: string; // base64(wrapped data key)
  iv: string; // base64
  ct: string; // base64
}

function encodeEnvelope(e: Envelope): string {
  return HANDLE_PREFIX + Buffer.from(JSON.stringify(e), 'utf8').toString('base64url');
}

function decodeEnvelope(handle: string): Envelope {
  if (!handle.startsWith(HANDLE_PREFIX)) throw new Error('unrecognized vault handle');
  let e: Envelope;
  try {
    e = JSON.parse(Buffer.from(handle.slice(HANDLE_PREFIX.length), 'base64url').toString('utf8'));
  } catch {
    throw new Error('unrecognized vault handle');
  }
  if (e?.v !== 1 || typeof e.wk !== 'string' || typeof e.iv !== 'string' || typeof e.ct !== 'string') {
    throw new Error('unrecognized vault handle');
  }
  return e;
}

/** The vault: envelope encryption behind the put/readForPurpose/destroy interface. */
export class VaultClient {
  constructor(private readonly kek: KekProvider) {}

  describe(): string { return this.kek.describe(); }

  /** sha256 hex of the material — safe to display/store (support/rotation UX). */
  static fingerprint(material: string): string {
    return createHash('sha256').update(material, 'utf8').digest('hex');
  }

  /** Encrypt fresh material → opaque handle. The material is never returned. */
  async put(material: string): Promise<{ handle: string; fingerprint: string }> {
    const dataKey = randomBytes(DATA_KEY_BYTES);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', dataKey, iv);
    const ct = Buffer.concat([cipher.update(material, 'utf8'), cipher.final(), cipher.getAuthTag()]);
    // Store tag appended (fixed 16 bytes) so decrypt can split it back off.
    const wrapped = await this.kek.wrapKey(dataKey);
    dataKey.fill(0);
    return {
      handle: encodeEnvelope({
        v: 1,
        kek: this.kek.describe(),
        wk: wrapped.toString('base64'),
        iv: iv.toString('base64'),
        ct: ct.toString('base64'),
      }),
      fingerprint: VaultClient.fingerprint(material),
    };
  }

  /**
   * Decrypt for a stated purpose ('invoke' | 'eval-probe'). v1 binds the
   * lease to the credential handle; per-purpose key separation is a future
   * hardening (the parameter reserves the seam). The material lives only in
   * the caller's memory — this function never logs or persists it.
   */
  async readForPurpose(handle: string, _purpose: 'invoke' | 'eval-probe'): Promise<string> {
    const e = decodeEnvelope(handle);
    const dataKey = await this.kek.unwrapKey(Buffer.from(e.wk, 'base64'));
    try {
      const iv = Buffer.from(e.iv, 'base64');
      const blob = Buffer.from(e.ct, 'base64');
      if (blob.length < 16) throw new Error('malformed envelope');
      const ct = blob.subarray(0, blob.length - 16);
      const tag = blob.subarray(blob.length - 16);
      const decipher = createDecipheriv('aes-256-gcm', dataKey, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
    } finally {
      dataKey.fill(0);
    }
  }

  /**
   * Destroy a vault version. With the self-contained envelope layout the
   * erasure itself happens in the credentials row (revoke tombstones the
   * handle); destroy() verifies the handle is one of ours and is a no-op
   * otherwise — the interface reserves real destruction for external vault
   * stores (e.g. Secrets Manager, where the secret lives outside Postgres).
   */
  async destroy(handle: string): Promise<void> {
    decodeEnvelope(handle); // throws on foreign/malformed handles
  }
}

export interface VaultResolution {
  configured: boolean;
  vault?: VaultClient;
}

/**
 * Resolve the vault from the environment. Read per call (not cached at
 * import) so tests can stub env vars and operators can rotate config
 * without a restart.
 */
export function resolveVault(): VaultResolution {
  const kmsKeyId = process.env.CF_BROKER_KMS_KEY_ID?.trim();
  if (kmsKeyId) return { configured: true, vault: new VaultClient(new KmsKekProvider(kmsKeyId)) };
  const devKey = process.env.CF_BROKER_DEV_KEY?.trim();
  if (devKey) return { configured: true, vault: new VaultClient(new DevKekProvider(devKey)) };
  return { configured: false };
}

/** Throw 503 credential_storage_not_configured unless a vault is configured. */
export function requireVault(): VaultClient {
  const r = resolveVault();
  if (!r.configured || !r.vault) {
    throw new HttpError(503, 'credential_storage_not_configured',
      'Credential storage is not configured. Set CF_BROKER_KMS_KEY_ID (production) or CF_BROKER_DEV_KEY (local dev) to enable the credential broker.');
  }
  return r.vault;
}

/**
 * Boot guard: the dev KEK must never exist in production — a dev key in
 * prod would silently downgrade the whole vault to a static local secret.
 * Called from index.ts before the server starts listening.
 */
export function assertBrokerBoot(): void {
  if (process.env.NODE_ENV === 'production' && process.env.CF_BROKER_DEV_KEY?.trim()) {
    throw new Error('Refusing to boot: CF_BROKER_DEV_KEY is set in production. Unset it and configure CF_BROKER_KMS_KEY_ID.');
  }
}
