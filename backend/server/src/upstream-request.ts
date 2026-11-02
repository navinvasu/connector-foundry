// Shared upstream-request assembly (BE-16). Runtime invoke and eval
// probes both turn a frozen tool snapshot + caller args into one upstream
// HTTP request through here, so the wire format can never drift between
// "certified by eval" and "served by the data plane" (the same reason
// AB-02/EV-01 share credential injection). Pure: no I/O, no injection —
// callers own auth, timeouts, and the fetch itself.

export interface ParamBinding {
  arg: string;
  location: string; // 'path' | 'query' | 'header' | 'cookie' | 'body'
  target: string;   // upstream name; '' on a body binding = the whole body
}

export interface UpstreamSnapshot {
  method?: string;
  path_template?: string;
  base_url?: string;
  param_bindings?: ParamBinding[];
}

export interface AssembledRequest {
  method: string;
  /** Path template with path args substituted. */
  path: string;
  /** Query args. Callers may still add auth injection before finalizing. */
  query: URLSearchParams;
  /** Header + cookie params (BE-17), keyed by spec-declared casing. */
  headers: Record<string, string>;
  /** Assembled JSON body; `undefined` when no body value was supplied. */
  body: unknown;
  /** True when a body should be sent (send `JSON.stringify(body)`). */
  hasBody: boolean;
}

/**
 * BE-17: set a header case-insensitively — HTTP header names are
 * case-insensitive, but the plain-object header maps used across the
 * runtime/eval/fetch boundary are not. Without this, a param header
 * `authorization` and an injected `Authorization` would ride as two
 * entries and reach the upstream combined. The last writer wins; the
 * winner's casing survives.
 */
export function setHeader(headers: Record<string, string>, name: string, value: string): void {
  for (const k of Object.keys(headers)) {
    if (k !== name && k.toLowerCase() === name.toLowerCase()) delete headers[k];
  }
  headers[name] = value;
}

/**
 * BE-17: merge one `name=value` cookie pair into the `Cookie` header
 * (creating it when absent, under the canonical `Cookie` casing). A pair
 * with the same cookie name is replaced — the later writer wins that
 * name; every other pair is preserved. Pairs join with '; '.
 */
export function mergeCookiePair(headers: Record<string, string>, name: string, value: string): void {
  mergeCookieFragment(headers, `${name}=${value}`);
}

/** Merge a raw cookie fragment ('a=1; b=2') pair-by-pair; see above. */
export function mergeCookieFragment(headers: Record<string, string>, fragment: string): void {
  const key = Object.keys(headers).find((k) => k.toLowerCase() === 'cookie');
  const segments = (key ? headers[key] : '')
    .split(';').map((s) => s.trim()).filter(Boolean);
  for (const seg of fragment.split(';').map((s) => s.trim()).filter(Boolean)) {
    const eq = seg.indexOf('=');
    const name = (eq === -1 ? seg : seg.slice(0, eq)).trim();
    const idx = segments.findIndex((s) => {
      const e = s.indexOf('=');
      return (e === -1 ? s : s.slice(0, e)).trim() === name;
    });
    if (idx >= 0) segments[idx] = seg; else segments.push(seg);
  }
  if (key && key !== 'Cookie') delete headers[key];
  headers['Cookie'] = segments.join('; ');
}

export function assembleUpstreamRequest(
  up: UpstreamSnapshot,
  args: Record<string, unknown>,
): AssembledRequest {
  let path = up.path_template ?? '/';
  const query = new URLSearchParams();
  const headers: Record<string, string> = {};
  const bodyFields: Record<string, unknown> = {};
  let wholeBody: unknown;
  let hasWholeBody = false;
  let hasBodyFields = false;

  for (const b of up.param_bindings ?? []) {
    const v = args[b.arg];
    if (v === undefined) continue;
    if (b.location === 'path') {
      path = path.replace(`{${b.target}}`, encodeURIComponent(String(v)));
    } else if (b.location === 'query') {
      query.set(b.target, String(v));
    } else if (b.location === 'header') {
      // BE-17: non-auth header params (tenant id, API version, …) now
      // reach the wire. A param that declares the Cookie header itself
      // carries a whole cookie string — merge it pair-by-pair with any
      // cookie params instead of overwriting them.
      if (b.target.toLowerCase() === 'cookie') mergeCookieFragment(headers, String(v));
      else setHeader(headers, b.target, String(v));
    } else if (b.location === 'cookie') {
      // BE-17: each cookie param is one pair of the single Cookie header.
      mergeCookiePair(headers, b.target, String(v));
    } else if (b.location === 'body') {
      // BE-16: field bindings assemble one JSON object; a binding with an
      // empty target carries the whole body (free-form / non-object body
      // schemas compile to a single such binding, and it wins if both
      // shapes somehow appear).
      if (b.target === '') { wholeBody = v; hasWholeBody = true; }
      else { bodyFields[b.target] = v; hasBodyFields = true; }
    }
  }

  const body = hasWholeBody ? wholeBody : hasBodyFields ? bodyFields : undefined;
  return {
    method: (up.method ?? 'GET').toUpperCase(),
    path,
    query,
    headers,
    body,
    hasBody: hasWholeBody || hasBodyFields,
  };
}

/** Final URL for an assembled request (after any auth-injection query adds). */
export function upstreamUrl(baseUrl: string, path: string, query: URLSearchParams): string {
  const qs = query.toString();
  return `${baseUrl}${path}${qs ? `?${qs}` : ''}`;
}
