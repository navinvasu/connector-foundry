// AB-02 injection tests: the single code path runtime and eval share.
import { describe, it, expect } from 'vitest';
import { injectionFor, applyInjection, DEFAULT_INJECTION } from './inject.js';

describe('injectionFor', () => {
  it('returns null for non-api_key tools', () => {
    expect(injectionFor({ credential_mode: 'none', upstream: {} })).toBeNull();
    expect(injectionFor({ credential_mode: 'oauth', upstream: {} })).toBeNull();
    expect(injectionFor(null)).toBeNull();
    expect(injectionFor(undefined)).toBeNull();
  });

  it('uses the frozen snapshot descriptor', () => {
    expect(injectionFor({
      credential_mode: 'api_key',
      upstream: { auth_injection: { location: 'header', name: 'Authorization', scheme: 'bearer' } },
    })).toEqual({ location: 'header', name: 'Authorization', scheme: 'bearer' });
  });

  it('falls back to the X-API-Key default for pre-AB-02 snapshots (D-35)', () => {
    expect(injectionFor({ credential_mode: 'api_key', upstream: {} })).toEqual(DEFAULT_INJECTION);
    expect(injectionFor({ credential_mode: 'api_key' })).toEqual(DEFAULT_INJECTION);
    expect(DEFAULT_INJECTION).toEqual({ location: 'header', name: 'X-API-Key' });
  });

  it('sanitizes malformed frozen descriptors back to the default', () => {
    expect(injectionFor({
      credential_mode: 'api_key',
      upstream: { auth_injection: { location: 'smoke', name: '' } as any },
    })).toEqual(DEFAULT_INJECTION);
  });

  it('preserves cookie descriptors', () => {
    expect(injectionFor({
      credential_mode: 'api_key',
      upstream: { auth_injection: { location: 'header', name: 'Cookie', cookieName: 'sess' } },
    })).toEqual({ location: 'header', name: 'Cookie', cookieName: 'sess' });
  });
});

describe('applyInjection', () => {
  it('header key', () => {
    const h: Record<string, string> = {};
    const q = new URLSearchParams();
    applyInjection(h, q, 'KEY', { location: 'header', name: 'X-API-Key' });
    expect(h).toEqual({ 'X-API-Key': 'KEY' });
    expect(q.toString()).toBe('');
  });

  it('bearer', () => {
    const h: Record<string, string> = {};
    applyInjection(h, new URLSearchParams(), 'KEY', { location: 'header', name: 'Authorization', scheme: 'bearer' });
    expect(h).toEqual({ Authorization: 'Bearer KEY' });
  });

  it('basic (key as username, empty password)', () => {
    const h: Record<string, string> = {};
    applyInjection(h, new URLSearchParams(), 'KEY', { location: 'header', name: 'Authorization', scheme: 'basic' });
    expect(h).toEqual({ Authorization: 'Basic ' + Buffer.from('KEY:', 'utf8').toString('base64') });
  });

  it('query (preserves existing params)', () => {
    const h: Record<string, string> = {};
    const q = new URLSearchParams('a=1');
    applyInjection(h, q, 'KEY', { location: 'query', name: 'api_key' });
    expect(q.get('api_key')).toBe('KEY');
    expect(q.get('a')).toBe('1');
    expect(h).toEqual({});
  });

  it('cookie via the Cookie header', () => {
    const h: Record<string, string> = {};
    applyInjection(h, new URLSearchParams(), 'KEY', { location: 'header', name: 'Cookie', cookieName: 'sess' });
    expect(h).toEqual({ Cookie: 'sess=KEY' });
  });

  it('BE-17: injected header wins a collision with a caller header param, case-insensitively', () => {
    // Assembled caller params land in this map first (upstream-request.ts).
    const h: Record<string, string> = { authorization: 'caller-supplied' };
    applyInjection(h, new URLSearchParams(), 'KEY', { location: 'header', name: 'Authorization', scheme: 'bearer' });
    expect(h).toEqual({ Authorization: 'Bearer KEY' });
  });

  it('BE-17: injected cookie replaces the same-named caller cookie and keeps the rest', () => {
    const h: Record<string, string> = { Cookie: 'sess=caller; prefs=dark' };
    applyInjection(h, new URLSearchParams(), 'KEY', { location: 'header', name: 'Cookie', cookieName: 'sess' });
    expect(h).toEqual({ Cookie: 'sess=KEY; prefs=dark' });
  });
});
