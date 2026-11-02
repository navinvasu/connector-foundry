// AB-02 vault tests: envelope encryption with the dev KEK (test fixture
// key only — never a real secret), boot guard, and env resolution.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { VaultClient, DevKekProvider, resolveVault, requireVault, assertBrokerBoot } from './vault.js';
import { HttpError } from '../errors.js';

// 32-byte fixture key (hex). Not a secret — a deterministic test vector.
const DEV_KEY = '0123456789abcdef'.repeat(4);
const OTHER_KEY = 'fedcba9876543210'.repeat(4);

beforeEach(() => { vi.unstubAllEnvs(); });
afterEach(() => { vi.unstubAllEnvs(); });

describe('DevKekProvider', () => {
  it('round-trips a data key', async () => {
    const kek = new DevKekProvider(DEV_KEY);
    const dk = Buffer.from('x'.repeat(32));
    expect(await kek.unwrapKey(await kek.wrapKey(dk))).toEqual(dk);
  });

  it('accepts base64 as well as hex', async () => {
    const b64 = Buffer.from(DEV_KEY, 'hex').toString('base64');
    const kek = new DevKekProvider(b64);
    const dk = Buffer.from('y'.repeat(32));
    expect(await kek.unwrapKey(await kek.wrapKey(dk))).toEqual(dk);
  });

  it('rejects malformed keys', () => {
    expect(() => new DevKekProvider('short')).toThrow(/32 bytes/);
    expect(() => new DevKekProvider('zz'.repeat(32))).toThrow(/32 bytes/);
  });

  it('rejects tampered wrapped keys', async () => {
    const kek = new DevKekProvider(DEV_KEY);
    const wrapped = await kek.wrapKey(Buffer.from('x'.repeat(32)));
    wrapped[20] ^= 1;
    await expect(kek.unwrapKey(wrapped)).rejects.toThrow();
  });
});

describe('VaultClient envelope', () => {
  it('put → readForPurpose round-trips; the handle carries no cleartext', async () => {
    const v = new VaultClient(new DevKekProvider(DEV_KEY));
    const { handle, fingerprint } = await v.put('sk-live-test-key');
    expect(handle.startsWith('cfv1.')).toBe(true);
    expect(handle).not.toContain('sk-live-test-key');
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(await v.readForPurpose(handle, 'invoke')).toBe('sk-live-test-key');
  });

  it('mints a fresh data key + IV per put (same material, different handle)', async () => {
    const v = new VaultClient(new DevKekProvider(DEV_KEY));
    const a = await v.put('same-key');
    const b = await v.put('same-key');
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.handle).not.toBe(b.handle);
  });

  it('rejects foreign and malformed handles without leaking', async () => {
    const v = new VaultClient(new DevKekProvider(DEV_KEY));
    await expect(v.readForPurpose('not-a-handle', 'invoke')).rejects.toThrow('unrecognized vault handle');
    const bad = 'cfv1.' + Buffer.from('{"v":9}', 'utf8').toString('base64url');
    await expect(v.readForPurpose(bad, 'invoke')).rejects.toThrow('unrecognized vault handle');
  });

  it('rejects envelopes wrapped by a different KEK', async () => {
    const v1 = new VaultClient(new DevKekProvider(DEV_KEY));
    const v2 = new VaultClient(new DevKekProvider(OTHER_KEY));
    const { handle } = await v1.put('k');
    await expect(v2.readForPurpose(handle, 'invoke')).rejects.toThrow();
  });

  it('destroy accepts our handles and rejects foreign ones', async () => {
    const v = new VaultClient(new DevKekProvider(DEV_KEY));
    const { handle } = await v.put('k');
    await expect(v.destroy(handle)).resolves.toBeUndefined();
    await expect(v.destroy('nope')).rejects.toThrow('unrecognized vault handle');
  });
});

describe('resolveVault / requireVault', () => {
  it('is unconfigured with no env vars → 503 credential_storage_not_configured', () => {
    expect(resolveVault().configured).toBe(false);
    try {
      requireVault();
      expect.unreachable();
    } catch (e: any) {
      expect(e).toBeInstanceOf(HttpError);
      expect(e.status).toBe(503);
      expect(e.code).toBe('credential_storage_not_configured');
    }
  });

  it('prefers KMS when CF_BROKER_KMS_KEY_ID is set', () => {
    vi.stubEnv('CF_BROKER_KMS_KEY_ID', 'alias/foundry-test');
    vi.stubEnv('CF_BROKER_DEV_KEY', DEV_KEY);
    const r = resolveVault();
    expect(r.configured).toBe(true);
    expect(r.vault!.describe()).toBe('kms:alias/foundry-test');
  });

  it('uses the dev KEK when only the dev key is set', () => {
    vi.stubEnv('CF_BROKER_DEV_KEY', DEV_KEY);
    const r = resolveVault();
    expect(r.configured).toBe(true);
    expect(r.vault!.describe()).toBe('dev');
  });
});

describe('assertBrokerBoot', () => {
  it('refuses to boot with a dev key in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('CF_BROKER_DEV_KEY', DEV_KEY);
    expect(() => assertBrokerBoot()).toThrow(/Refusing to boot/);
  });

  it('allows a dev key outside production', () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('CF_BROKER_DEV_KEY', DEV_KEY);
    expect(() => assertBrokerBoot()).not.toThrow();
  });

  it('allows production with KMS configured', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('CF_BROKER_KMS_KEY_ID', 'alias/foundry-test');
    expect(() => assertBrokerBoot()).not.toThrow();
  });
});
