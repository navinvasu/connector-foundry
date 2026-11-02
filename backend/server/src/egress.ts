// Upstream egress policy (SE-08, from SE-06 findings F-2/F-3).
//
// Every server-side fetch of a tenant- or importer-controlled URL —
// runtime invoke, eval probes, spec/collection import — goes through
// this module instead of bare `fetch`. Bare fetch made three attacks
// free: (1) SSRF to loopback/private/link-local targets (cloud metadata
// at 169.254.169.254 above all), including via a public URL that 302s
// to one, because undici followed up to 20 redirects unchecked;
// (2) memory exhaustion via unbounded `res.text()`; (3) spec-import
// fetches with no timeout at all, hanging a request forever.
//
// The policy, applied to the initial URL AND every redirect hop:
//   - scheme allowlist: http / https only;
//   - `localhost` names (and `*.localhost`) are refused;
//   - literal-IP targets, and every DNS answer for a hostname target,
//     are refused when they are loopback / RFC-1918 / link-local /
//     unique-local / CGNAT / multicast / unspecified / otherwise
//     non-public (see isBlockedIp). If DNS resolution fails we defer to
//     the fetch itself — a name that cannot resolve cannot connect —
//     rather than inventing a second failure mode; mocked/stubbed
//     upstreams in tests rely on this.
//   - redirects are followed manually (max 5), re-validating each hop;
//     301/302/303 rewrite POST→GET and drop the body, per fetch spec;
//   - response bodies are read with a hard byte cap (default 5 MiB,
//     `CF_EGRESS_MAX_RESPONSE_BYTES`) — over-cap aborts the read instead
//     of buffering an unbounded body;
//   - callers own timeouts via `signal`; `fetchSpec` previously had
//     none, so it passes `timeoutMs` here and the wrapper enforces it
//     across all hops.
//
// Deliberate escape hatch: CF_EGRESS_ALLOW_PRIVATE=true skips the
// private-address rejection (scheme + redirect + size rules still
// apply). It exists for local development and the wire-level tests that
// run a stub upstream on 127.0.0.1; like the dev-auth bypass it must
// never be set in a real deployment. Production boot posture for this
// flag is a candidate for the boot guards (noted in the design doc).
//
// Known caveat (DNS TOCTOU / rebinding): we resolve-then-check, then
// fetch resolves again. A hostile DNS server could answer a public IP
// to our check and a private one to the fetch. Fully closing that
// needs connect-time IP pinning (custom undici dispatcher), deferred —
// see the SE-08 design doc. The check still closes the direct and
// redirect-hop paths, which are the findings' exploit routes.
//
// The S3 report upload (report.ts) is intentionally NOT routed here:
// its destination is operator-configured AWS config, never tenant or
// importer input.

import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

export type EgressBlockReason =
  | 'invalid_url'
  | 'scheme_not_allowed'
  | 'blocked_hostname'
  | 'private_address'
  | 'response_too_large'
  | 'too_many_redirects';

export class EgressError extends Error {
  readonly reason: EgressBlockReason;
  constructor(reason: EgressBlockReason, message: string) {
    super(message);
    this.name = 'EgressError';
    this.reason = reason;
  }
}

// ─── IP classification ────────────────────────────────────────────────

function ipv4Parts(ip: string): number[] | null {
  const parts = ip.split('.').map((p) => Number(p));
  return parts.length === 4 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)
    ? parts : null;
}

function ipv4In(ip: number[], base: string, prefix: number): boolean {
  const b = ipv4Parts(base);
  if (!b) return false;
  const toInt = (p: number[]) => ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (toInt(ip) & mask) === (toInt(b) & mask);
}

/** Non-public IPv4 ranges that can reach internal/non-public hosts.
 *  Documentation (TEST-NET), benchmarking (198.18/15) and other
 *  special-purpose ranges are deliberately NOT blocked: they are never
 *  assigned to internal services, connection attempts to them fail at
 *  the network layer anyway, and 198.18/15 in particular is what
 *  fake-IP DNS proxies answer for ordinary public names — blocking it
 *  would refuse every legitimate upstream behind such a resolver. */
const BLOCKED_V4: Array<[string, number]> = [
  ['0.0.0.0', 8],        // "this network" / unspecified
  ['10.0.0.0', 8],       // RFC-1918 private
  ['100.64.0.0', 10],    // CGNAT shared address space (incl. cloud metadata in it)
  ['127.0.0.0', 8],      // loopback
  ['169.254.0.0', 16],   // link-local (cloud metadata lives here)
  ['172.16.0.0', 12],    // RFC-1918 private
  ['192.168.0.0', 16],   // RFC-1918 private
  ['224.0.0.0', 4],      // multicast
  ['240.0.0.0', 4],      // reserved (incl. broadcast)
];

function isBlockedIpv4(ip: string): boolean {
  const parts = ipv4Parts(ip);
  if (!parts) return true; // unparseable literal: fail closed
  return BLOCKED_V4.some(([base, prefix]) => ipv4In(parts, base, prefix));
}

function expandIpv6(ip: string): string {
  let s = ip.toLowerCase();
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  // IPv4-mapped / -compatible tail (::ffff:127.0.0.1) → check the IPv4.
  const lastColon = s.lastIndexOf(':');
  const tail = lastColon >= 0 ? s.slice(lastColon + 1) : '';
  if (tail.includes('.')) {
    const v4 = ipv4Parts(tail);
    if (!v4) return s;
    const hex = ((v4[0] << 8) | v4[1]).toString(16) + ':' + ((v4[2] << 8) | v4[3]).toString(16);
    s = s.slice(0, lastColon + 1) + hex;
  }
  if (!s.includes('::')) {
    return s.split(':').map((h) => h.padStart(4, '0')).join(':');
  }
  const [left, right] = s.split('::');
  const l = left ? left.split(':') : [];
  const r = right ? right.split(':') : [];
  const missing = 8 - l.length - r.length;
  return [...l, ...Array(Math.max(missing, 0)).fill('0'), ...r]
    .map((h) => h.padStart(4, '0')).join(':');
}

function isBlockedIpv6(ip: string): boolean {
  const h = expandIpv6(ip).split(':').map((x) => parseInt(x, 16));
  if (h.length !== 8 || h.some((n) => Number.isNaN(n))) return true; // fail closed
  const first = h[0];
  // IPv4-mapped ::ffff:a.b.c.d → judge by the embedded IPv4 answer.
  if (h.slice(0, 5).every((n) => n === 0) && h[5] === 0xffff) {
    return isBlockedIpv4(`${h[6] >> 8}.${h[6] & 255}.${h[7] >> 8}.${h[7] & 255}`);
  }
  if (h.every((n) => n === 0)) return true;                               // :: unspecified
  if (h.slice(0, 7).every((n) => n === 0) && h[7] === 1) return true;     // ::1 loopback
  if ((first & 0xfe00) === 0xfc00) return true;                           // fc00::/7 unique-local
  if ((first & 0xffc0) === 0xfe80) return true;                           // fe80::/10 link-local
  if ((first & 0xff00) === 0xff00) return true;                           // ff00::/8 multicast
  return false;
}

/** True when `ip` is loopback/private/link-local/other non-public. */
export function isBlockedIp(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return isBlockedIpv4(ip);
  if (kind === 6) return isBlockedIpv6(ip);
  return true; // not an IP literal at all: callers must not pass hostnames here
}

// ─── URL validation ───────────────────────────────────────────────────

export type LookupFn = (hostname: string) => Promise<string[]>;

const defaultLookup: LookupFn = async (hostname) => {
  const rows = await lookup(hostname, { all: true });
  return rows.map((r) => r.address);
};

export function egressAllowPrivate(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CF_EGRESS_ALLOW_PRIVATE === 'true';
}

export interface AssertEgressOptions {
  allowPrivate?: boolean;
  lookup?: LookupFn;
}

/**
 * Validate one egress target (an initial URL or one redirect hop).
 * Throws EgressError on any policy violation; DNS failures defer to the
 * fetch (resolve step inside fetchWithEgress reports them naturally).
 */
export async function assertEgressUrlAllowed(
  rawUrl: string | URL,
  opts: AssertEgressOptions = {},
): Promise<URL> {
  let url: URL;
  try {
    url = typeof rawUrl === 'string' ? new URL(rawUrl) : rawUrl;
  } catch {
    throw new EgressError('invalid_url', `Egress blocked: "${String(rawUrl)}" is not a valid URL.`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new EgressError('scheme_not_allowed',
      `Egress blocked: scheme "${url.protocol.replace(':', '')}" is not allowed (http/https only).`);
  }
  const allowPrivate = opts.allowPrivate ?? egressAllowPrivate();
  if (allowPrivate) return url;

  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost')) {
    throw new EgressError('blocked_hostname', `Egress blocked: host "${host}" is not a public upstream.`);
  }
  // URL keeps brackets on IPv6 hostnames ([::1]); strip before isIP.
  const bareHost = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (isIP(bareHost)) {
    if (isBlockedIp(bareHost)) {
      throw new EgressError('private_address',
        `Egress blocked: ${bareHost} is a private, loopback, or link-local address.`);
    }
    return url;
  }
  // Hostname: every DNS answer must be public — one private answer is
  // enough for the fetch to land internally (answer order is not ours).
  let addresses: string[] = [];
  try {
    addresses = await (opts.lookup ?? defaultLookup)(host);
  } catch {
    return url; // unresolvable: the fetch will surface the real DNS error
  }
  for (const addr of addresses) {
    if (isBlockedIp(addr)) {
      throw new EgressError('private_address',
        `Egress blocked: host "${host}" resolves to a private, loopback, or link-local address.`);
    }
  }
  return url;
}

// ─── Policy-enforcing fetch ───────────────────────────────────────────

export interface EgressRequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export interface EgressResponse {
  status: number;
  statusText: string;
  ok: boolean;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export interface FetchEgressOptions extends AssertEgressOptions {
  /** Hard cap on the response-body size in bytes. */
  maxResponseBytes?: number;
  /** Max redirect hops followed (each re-validated). Default 5. */
  maxRedirects?: number;
  /** Overall timeout across all hops (fetchSpec passes 15s). */
  timeoutMs?: number;
  /** Injectable for tests; defaults to the global fetch. Deliberately
   *  loosely typed — production passes the real fetch, tests pass
   *  response-shaped stubs (status/text/headers) the reader tolerates. */
  fetchImpl?: (url: string, init?: unknown) => Promise<unknown>;
}

export function resolveMaxResponseBytes(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.CF_EGRESS_MAX_RESPONSE_BYTES);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 5 * 1024 * 1024;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function headerGetter(res: any): { get(name: string): string | null } {
  return {
    get(name: string): string | null {
      const h = res?.headers;
      if (!h) return null;
      if (typeof h.get === 'function') {
        try { return h.get(name); } catch { return null; }
      }
      if (typeof h === 'object') {
        const key = Object.keys(h).find((k) => k.toLowerCase() === name.toLowerCase());
        return key ? String(h[key]) : null;
      }
      return null;
    },
  };
}

/** Read a (possibly mocked) response body under the byte cap. */
async function readBodyCapped(res: any, maxBytes: number): Promise<string> {
  const decoder = new TextDecoder();
  const body = res?.body;
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader();
    let total = 0;
    let out = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        try { await reader.cancel(); } catch { /* already closed */ }
        throw new EgressError('response_too_large',
          `Egress blocked: upstream response exceeded the ${maxBytes}-byte limit.`);
      }
      out += decoder.decode(value, { stream: true });
    }
    out += decoder.decode();
    return out;
  }
  if (typeof res?.text === 'function') {
    const text = await res.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) {
      throw new EgressError('response_too_large',
        `Egress blocked: upstream response exceeded the ${maxBytes}-byte limit.`);
    }
    return text;
  }
  if (typeof res?.text === 'string') return res.text;
  return '';
}

/**
 * `fetch` under the egress policy: validates the target, follows
 * redirects manually with per-hop re-validation, and returns a minimal
 * response whose `text()` is the size-capped body. Errors from the
 * underlying fetch (DNS, TLS, abort) propagate unchanged so callers
 * keep their existing timeout/unreachable mapping.
 */
export async function fetchWithEgress(
  rawUrl: string,
  init: EgressRequestInit = {},
  opts: FetchEgressOptions = {},
): Promise<EgressResponse> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const maxBytes = opts.maxResponseBytes ?? resolveMaxResponseBytes();
  const maxRedirects = opts.maxRedirects ?? 5;

  // One timeout spanning every hop; a caller-supplied signal stays
  // authoritative and is linked in both directions.
  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (opts.timeoutMs && opts.timeoutMs > 0) {
    timer = setTimeout(() => ctrl.abort(), opts.timeoutMs);
  }
  const callerSignal = init.signal;
  const onCallerAbort = () => ctrl.abort();
  if (callerSignal) {
    if (callerSignal.aborted) ctrl.abort();
    else callerSignal.addEventListener('abort', onCallerAbort, { once: true });
  }

  try {
    let url = await assertEgressUrlAllowed(rawUrl, opts);
    let method = (init.method ?? 'GET').toUpperCase();
    let body = init.body;
    let headers: Record<string, string> = { ...(init.headers ?? {}) };

    for (let hop = 0; ; hop++) {
      const res: any = await fetchImpl(url.toString(), {
        method,
        headers,
        redirect: 'manual',
        signal: ctrl.signal,
        ...(body !== undefined ? { body } : {}),
      } as RequestInit);
      const status = Number(res?.status ?? 0);
      const headersOut = headerGetter(res);
      const location = REDIRECT_STATUSES.has(status) ? headersOut.get('location') : null;

      if (!location) {
        const text = await readBodyCapped(res, maxBytes);
        return {
          status,
          statusText: String(res?.statusText ?? ''),
          ok: status >= 200 && status < 300,
          headers: headersOut,
          text: async () => text,
        };
      }

      if (hop >= maxRedirects) {
        throw new EgressError('too_many_redirects',
          `Egress blocked: upstream redirected more than ${maxRedirects} times.`);
      }
      // Drain/cancel the redirect body so the socket is released.
      try { await res?.body?.cancel?.(); } catch { /* mocked responses may lack it */ }

      // Relative Location resolves against the current (validated) URL;
      // the target itself is fully re-validated before the next hop.
      const next = new URL(location, url);
      url = await assertEgressUrlAllowed(next, opts);
      if (status === 303 || ((status === 301 || status === 302) && method === 'POST')) {
        method = 'GET';
        body = undefined;
        headers = Object.fromEntries(
          Object.entries(headers).filter(([k]) => !/^content-/i.test(k)));
      }
    }
  } finally {
    if (timer) clearTimeout(timer);
    if (callerSignal) callerSignal.removeEventListener('abort', onCallerAbort);
  }
}
