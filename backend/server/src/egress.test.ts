// SE-08 — upstream egress policy (SE-06 F-2/F-3).
// Unit-proof of the SSRF guard: IP classification, scheme/hostname/DNS
// checks, per-redirect-hop re-validation, size cap, and the explicit
// CF_EGRESS_ALLOW_PRIVATE escape hatch the localhost wire suites use.
// All fetches are stubbed; DNS is injected so tests never resolve.
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  isBlockedIp,
  assertEgressUrlAllowed,
  fetchWithEgress,
  EgressError,
} from './egress.js';
import { fetchSpec } from './openapi.js';

const publicLookup = async () => ['93.184.216.34']; // example.com's public answer shape
const privateLookup = async () => ['10.0.0.7'];
const mixedLookup = async () => ['93.184.216.34', '192.168.1.1'];

function fakeResponse(status: number, bodyText: string, headers: Record<string, string> = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status,
    statusText: status === 200 ? 'OK' : 'Redirect',
    ok: status >= 200 && status < 300,
    headers: { get: (n: string) => lower[n.toLowerCase()] ?? null },
    text: async () => bodyText,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('isBlockedIp', () => {
  it('blocks loopback, private, link-local, and other non-public IPv4', () => {
    for (const ip of [
      '127.0.0.1', '127.53.0.9', '10.1.2.3', '172.16.0.1', '172.31.255.255',
      '192.168.0.1', '169.254.169.254', '0.0.0.0', '100.64.0.1', '224.0.0.1',
      '255.255.255.255',
    ]) {
      expect(isBlockedIp(ip), ip).toBe(true);
    }
  });

  it('allows public IPv4 at range boundaries', () => {
    for (const ip of ['8.8.8.8', '93.184.216.34', '172.15.0.1', '172.32.0.1', '11.0.0.1', '193.0.0.1']) {
      expect(isBlockedIp(ip), ip).toBe(false);
    }
  });

  it('blocks non-public IPv6 incl. IPv4-mapped loopback; allows public v6', () => {
    for (const ip of ['::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1', '::ffff:127.0.0.1']) {
      expect(isBlockedIp(ip), ip).toBe(true);
    }
    for (const ip of ['2606:4700:4700::1111', '::ffff:8.8.8.8']) {
      expect(isBlockedIp(ip), ip).toBe(false);
    }
  });
});

describe('assertEgressUrlAllowed', () => {
  it('rejects non-http(s) schemes', async () => {
    await expect(assertEgressUrlAllowed('file:///etc/passwd')).rejects.toMatchObject({ reason: 'scheme_not_allowed' });
    await expect(assertEgressUrlAllowed('gopher://example.com/')).rejects.toBeInstanceOf(EgressError);
  });

  it('rejects localhost names without any DNS call', async () => {
    const lookup = vi.fn(async () => ['8.8.8.8']);
    await expect(assertEgressUrlAllowed('http://localhost:8080/admin', { lookup }))
      .rejects.toMatchObject({ reason: 'blocked_hostname' });
    await expect(assertEgressUrlAllowed('http://api.localhost/x', { lookup }))
      .rejects.toMatchObject({ reason: 'blocked_hostname' });
    expect(lookup).not.toHaveBeenCalled();
  });

  it('rejects literal private IPs (incl. cloud metadata) and allows public ones', async () => {
    await expect(assertEgressUrlAllowed('http://169.254.169.254/latest/meta-data/'))
      .rejects.toMatchObject({ reason: 'private_address' });
    await expect(assertEgressUrlAllowed('http://[::1]/x'))
      .rejects.toMatchObject({ reason: 'private_address' });
    await expect(assertEgressUrlAllowed('https://8.8.8.8/x'))
      .resolves.toMatchObject({ hostname: '8.8.8.8' });
  });

  it('rejects when ANY DNS answer is private; allows all-public answers', async () => {
    await expect(assertEgressUrlAllowed('https://api.example.com/x', { lookup: privateLookup }))
      .rejects.toMatchObject({ reason: 'private_address' });
    await expect(assertEgressUrlAllowed('https://api.example.com/x', { lookup: mixedLookup }))
      .rejects.toMatchObject({ reason: 'private_address' });
    await expect(assertEgressUrlAllowed('https://api.example.com/x', { lookup: publicLookup }))
      .resolves.toMatchObject({ hostname: 'api.example.com' });
  });

  it('defers to fetch on DNS failure (unresolvable names cannot connect)', async () => {
    const failing = async () => { throw new Error('getaddrinfo ENOTFOUND api.test'); };
    await expect(assertEgressUrlAllowed('https://api.test/x', { lookup: failing }))
      .resolves.toMatchObject({ hostname: 'api.test' });
  });

  it('allowPrivate skips address rejection but not the scheme allowlist', async () => {
    await expect(assertEgressUrlAllowed('http://127.0.0.1:9999/x', { allowPrivate: true }))
      .resolves.toMatchObject({ hostname: '127.0.0.1' });
    vi.stubEnv('CF_EGRESS_ALLOW_PRIVATE', 'true');
    await expect(assertEgressUrlAllowed('http://10.0.0.5/x')).resolves.toBeInstanceOf(URL);
    await expect(assertEgressUrlAllowed('file:///etc/passwd', { allowPrivate: true }))
      .rejects.toMatchObject({ reason: 'scheme_not_allowed' });
  });
});

describe('fetchWithEgress', () => {
  it('blocks a private target before any fetch happens', async () => {
    const fetchImpl = vi.fn(async () => fakeResponse(200, '{}'));
    await expect(fetchWithEgress('http://127.0.0.1/admin', {}, { fetchImpl, lookup: publicLookup }))
      .rejects.toMatchObject({ reason: 'private_address' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('follows a public redirect and returns the final body', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(fakeResponse(302, '', { location: 'https://api.example.com/final' }))
      .mockResolvedValueOnce(fakeResponse(200, '{"ok":true}'));
    const res = await fetchWithEgress('https://api.example.com/start', {}, { fetchImpl, lookup: publicLookup });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"ok":true}');
    expect(fetchImpl.mock.calls[1][0]).toBe('https://api.example.com/final');
    // Redirects are always manual so each hop is re-validated.
    expect(fetchImpl.mock.calls[0][1].redirect).toBe('manual');
  });

  it('blocks a redirect hop to a private target (the F-2 exploit path)', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(fakeResponse(302, '', { location: 'http://169.254.169.254/latest/meta-data/' }));
    await expect(fetchWithEgress('https://api.example.com/start', {}, { fetchImpl, lookup: publicLookup }))
      .rejects.toMatchObject({ reason: 'private_address' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('blocks a redirect to a host that resolves privately', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(fakeResponse(301, '', { location: 'https://internal.example.com/x' }));
    const lookup = async (h: string) => (h === 'internal.example.com' ? ['172.16.5.5'] : ['93.184.216.34']);
    await expect(fetchWithEgress('https://api.example.com/start', {}, { fetchImpl, lookup }))
      .rejects.toMatchObject({ reason: 'private_address' });
  });

  it('resolves relative redirect locations against the validated URL', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(fakeResponse(302, '', { location: '/v2/widgets' }))
      .mockResolvedValueOnce(fakeResponse(200, 'done'));
    const res = await fetchWithEgress('https://api.example.com/v1/widgets', {}, { fetchImpl, lookup: publicLookup });
    expect(fetchImpl.mock.calls[1][0]).toBe('https://api.example.com/v2/widgets');
    expect(await res.text()).toBe('done');
  });

  it('rewrites POST→GET (dropping body + content headers) on 303', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(fakeResponse(303, '', { location: 'https://api.example.com/next' }))
      .mockResolvedValueOnce(fakeResponse(200, 'ok'));
    await fetchWithEgress('https://api.example.com/submit',
      { method: 'POST', headers: { 'content-type': 'application/json', 'x-a': '1' }, body: '{"a":1}' },
      { fetchImpl, lookup: publicLookup });
    const second = fetchImpl.mock.calls[1][1];
    expect(second.method).toBe('GET');
    expect(second.body).toBeUndefined();
    expect(second.headers).toEqual({ 'x-a': '1' });
  });

  it('caps oversized responses', async () => {
    const fetchImpl = vi.fn(async () => fakeResponse(200, 'x'.repeat(2048)));
    await expect(fetchWithEgress('https://api.example.com/big', {}, { fetchImpl, lookup: publicLookup, maxResponseBytes: 1024 }))
      .rejects.toMatchObject({ reason: 'response_too_large' });
  });

  it('caps chunked streaming bodies via the reader (not just .text())', async () => {
    const chunks = [new Uint8Array(600), new Uint8Array(600), new Uint8Array(600)];
    let i = 0;
    const streamed = {
      status: 200, statusText: 'OK', ok: true,
      headers: { get: () => null },
      body: {
        getReader: () => ({
          read: async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true, value: undefined }),
          cancel: async () => undefined,
        }),
      },
    };
    const fetchImpl = vi.fn(async () => streamed);
    await expect(fetchWithEgress('https://api.example.com/stream', {}, { fetchImpl, lookup: publicLookup, maxResponseBytes: 1024 }))
      .rejects.toMatchObject({ reason: 'response_too_large' });
  });

  it('gives up after the redirect budget', async () => {
    const fetchImpl = vi.fn(async () => fakeResponse(302, '', { location: 'https://api.example.com/loop' }));
    await expect(fetchWithEgress('https://api.example.com/loop', {}, { fetchImpl, lookup: publicLookup, maxRedirects: 2 }))
      .rejects.toMatchObject({ reason: 'too_many_redirects' });
  });

  it('propagates underlying fetch errors unchanged (caller timeout/reachability mapping preserved)', async () => {
    const boom = new Error('socket hangup');
    const fetchImpl = vi.fn(async () => { throw boom; });
    await expect(fetchWithEgress('https://api.example.com/x', {}, { fetchImpl, lookup: publicLookup }))
      .rejects.toBe(boom);
  });
});

describe('fetchSpec (F-3 import path)', () => {
  it('refuses an internal spec URL without fetching it', async () => {
    const fetchImpl = vi.fn(async () => fakeResponse(200, '{}'));
    vi.stubGlobal('fetch', fetchImpl);
    await expect(fetchSpec('http://169.254.169.254/openapi.json')).rejects.toThrow(/Egress blocked/);
    expect(fetchImpl).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('still imports a public spec (status error message preserved)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(200, '{"openapi":"3.0.0"}')));
    await expect(fetchSpec('https://specs.example.com/openapi.json')).resolves.toEqual({ openapi: '3.0.0' });
    vi.unstubAllGlobals();
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(404, 'nope')));
    await expect(fetchSpec('https://specs.example.com/missing.json')).rejects.toThrow('Fetch failed: 404');
    vi.unstubAllGlobals();
  });
});
