import { describe, it, expect } from 'vitest';
import { smokeHintFor } from './smoke-hint.js';

describe('smokeHintFor', () => {
  it('translates the vault-not-configured 503 into setup steps', () => {
    const hint = smokeHintFor(
      'POST /v1/projects/p1/credentials → 503: {"error":"Credential storage is not configured.","code":"credential_storage_not_configured"}',
    );
    expect(hint).toContain('CF_BROKER_DEV_KEY');
    expect(hint).toContain('openssl rand -hex 32');
    expect(hint).toContain('restart the server');
  });

  it('returns null for unrelated errors (smoke rethrows them as-is)', () => {
    expect(smokeHintFor('POST /v1/projects → 500: boom')).toBeNull();
    expect(smokeHintFor('fetch failed')).toBeNull();
  });
});
