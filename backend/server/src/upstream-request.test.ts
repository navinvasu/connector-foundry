// BE-16: shared upstream-request assembly — the wire format runtime
// invoke and eval probes both speak.
import { describe, it, expect } from 'vitest';
import {
  assembleUpstreamRequest, mergeCookiePair, setHeader, upstreamUrl,
} from './upstream-request.js';

describe('assembleUpstreamRequest (BE-16)', () => {
  it('substitutes path + query args and defaults to GET without a body', () => {
    const r = assembleUpstreamRequest(
      { method: 'GET', path_template: '/widgets/{id}', base_url: 'https://api.test',
        param_bindings: [
          { arg: 'id', location: 'path', target: 'id' },
          { arg: 'verbose', location: 'query', target: 'verbose' },
        ] },
      { id: 'a b', verbose: true },
    );
    expect(r.method).toBe('GET');
    expect(r.path).toBe('/widgets/a%20b');
    expect(r.query.get('verbose')).toBe('true');
    expect(r.hasBody).toBe(false);
    expect(r.body).toBeUndefined();
    expect(upstreamUrl('https://api.test', r.path, r.query)).toBe('https://api.test/widgets/a%20b?verbose=true');
  });

  it('assembles body fields into one JSON object under their upstream names', () => {
    const r = assembleUpstreamRequest(
      { method: 'post', path_template: '/widgets', base_url: 'https://api.test',
        param_bindings: [
          { arg: 'name', location: 'body', target: 'name' },
          { arg: 'displayCount', location: 'body', target: 'display_count' },
        ] },
      { name: 'gear', displayCount: 3 },
    );
    expect(r.method).toBe('POST'); // snapshot method wins over the GET default
    expect(r.hasBody).toBe(true);
    expect(r.body).toEqual({ name: 'gear', display_count: 3 });
  });

  it('skips undefined body values but keeps explicit nulls', () => {
    const r = assembleUpstreamRequest(
      { method: 'POST', path_template: '/w', base_url: 'https://api.test',
        param_bindings: [
          { arg: 'name', location: 'body', target: 'name' },
          { arg: 'note', location: 'body', target: 'note' },
        ] },
      { note: null },
    );
    expect(r.body).toEqual({ note: null });
    const empty = assembleUpstreamRequest(
      { method: 'POST', path_template: '/w', base_url: 'https://api.test',
        param_bindings: [{ arg: 'name', location: 'body', target: 'name' }] },
      {},
    );
    expect(empty.hasBody).toBe(false);
    expect(empty.body).toBeUndefined();
  });

  it('carries a whole-body arg (empty target) verbatim, ahead of any fields', () => {
    const r = assembleUpstreamRequest(
      { method: 'PUT', path_template: '/w/1', base_url: 'https://api.test',
        param_bindings: [
          { arg: 'extra', location: 'body', target: 'extra' },
          { arg: 'body', location: 'body', target: '' },
        ] },
      { body: { anything: [1, 2] }, extra: 'ignored' },
    );
    expect(r.body).toEqual({ anything: [1, 2] });
  });

  it('transmits header params with their spec-declared names (BE-17)', () => {
    const r = assembleUpstreamRequest(
      { method: 'GET', path_template: '/w', base_url: 'https://api.test',
        param_bindings: [
          { arg: 'tenant', location: 'header', target: 'X-Tenant' },
          { arg: 'apiVersion', location: 'header', target: 'X-Api-Version' },
        ] },
      { tenant: 'acme', apiVersion: 2 },
    );
    expect(r.headers).toEqual({ 'X-Tenant': 'acme', 'X-Api-Version': '2' });
    expect(r.query.toString()).toBe('');
  });

  it('merges cookie params into one Cookie header (BE-17)', () => {
    const r = assembleUpstreamRequest(
      { method: 'GET', path_template: '/w', base_url: 'https://api.test',
        param_bindings: [
          { arg: 'session', location: 'cookie', target: 'session' },
          { arg: 'prefs', location: 'cookie', target: 'prefs' },
        ] },
      { session: 's1', prefs: 'dark' },
    );
    expect(r.headers).toEqual({ Cookie: 'session=s1; prefs=dark' });
  });

  it('skips undefined header/cookie args like every other location (BE-17)', () => {
    const r = assembleUpstreamRequest(
      { method: 'GET', path_template: '/w', base_url: 'https://api.test',
        param_bindings: [
          { arg: 'tenant', location: 'header', target: 'X-Tenant' },
          { arg: 'session', location: 'cookie', target: 'session' },
        ] },
      {},
    );
    expect(r.headers).toEqual({});
  });

  it('merges a raw Cookie header param with cookie params instead of overwriting (BE-17)', () => {
    const r = assembleUpstreamRequest(
      { method: 'GET', path_template: '/w', base_url: 'https://api.test',
        param_bindings: [
          { arg: 'session', location: 'cookie', target: 'session' },
          { arg: 'cookieHeader', location: 'header', target: 'Cookie' },
        ] },
      { session: 's1', cookieHeader: 'prefs=dark; session=override' },
    );
    // The header param's later `session` pair wins the name; prefs survives.
    expect(r.headers).toEqual({ Cookie: 'session=override; prefs=dark' });
  });
});

describe('header helpers (BE-17)', () => {
  it('setHeader replaces a case-variant instead of duplicating the header', () => {
    const h: Record<string, string> = { authorization: 'caller' };
    setHeader(h, 'Authorization', 'Bearer key');
    expect(h).toEqual({ Authorization: 'Bearer key' });
  });

  it('mergeCookiePair replaces the same cookie name and keeps the others', () => {
    const h: Record<string, string> = { Cookie: 'session=caller; prefs=dark' };
    mergeCookiePair(h, 'session', 'leased');
    expect(h).toEqual({ Cookie: 'session=leased; prefs=dark' });
  });
});
