// Credential injection (AB-02) — pure helpers, no DB, no secrets at rest.
//
// A tool's injection target is frozen at compile time into the immutable
// tool snapshot (`tool.upstream.auth_injection`, see compiler.ts). Runtime
// and eval share THIS module so there is exactly one code path that turns
// a lease into an upstream request ("no second code path", AB-01).

import { mergeCookiePair, setHeader } from '../upstream-request.js';

/** Where an API key goes on the upstream request. */
export interface AuthInjection {
  location: 'header' | 'query';
  /** Header name, or query param name. */
  name: string;
  /** Authorization-header scheme: `Bearer <key>` vs `Basic base64(key:)`. */
  scheme?: 'bearer' | 'basic';
  /**
   * Cookie auth (OpenAPI `in: cookie`): sent as a `Cookie` header with the
   * value `<cookieName>=<key>`. The header name itself stays `Cookie`.
   */
  cookieName?: string;
}

/** Fallback for snapshots compiled before AB-02 froze auth_injection. */
export const DEFAULT_INJECTION: AuthInjection = { location: 'header', name: 'X-API-Key' };

interface ToolLike {
  credential_mode?: string | null;
  upstream?: { auth_injection?: AuthInjection } | null;
}

/**
 * Injection target for an api_key tool. Returns the frozen descriptor when
 * the snapshot carries one, the documented X-API-Key default for older
 * snapshots (D-35 — recompile to pick up the spec's real target), and null
 * for non-api_key tools.
 */
export function injectionFor(tool: ToolLike | null | undefined): AuthInjection | null {
  if (!tool || tool.credential_mode !== 'api_key') return null;
  const frozen = tool.upstream?.auth_injection;
  if (frozen && (frozen.location === 'header' || frozen.location === 'query') && typeof frozen.name === 'string' && frozen.name) {
    return {
      location: frozen.location,
      name: frozen.name,
      ...(frozen.scheme === 'bearer' || frozen.scheme === 'basic' ? { scheme: frozen.scheme } : {}),
      ...(typeof frozen.cookieName === 'string' && frozen.cookieName ? { cookieName: frozen.cookieName } : {}),
    };
  }
  return { ...DEFAULT_INJECTION };
}

function basicValue(material: string): string {
  // Swagger 2.0 `basic` / OpenAPI `http`+`basic`: the API key is the
  // username, password empty — the common convention for key-as-basic-auth.
  return `Basic ${Buffer.from(`${material}:`, 'utf8').toString('base64')}`;
}

/**
 * Apply a lease's material to an outbound request. The material touches only
 * these two out-params (request-scoped memory) — never logs, never the DB.
 * BE-17 precedence: the injected credential is applied AFTER the caller's
 * header/cookie params (assembled by src/upstream-request.ts into the same
 * `headers` map) and wins every collision — a same-named header is replaced
 * case-insensitively (setHeader), a same-named cookie pair is replaced,
 * other caller cookies are preserved.
 */
export function applyInjection(
  headers: Record<string, string>,
  query: URLSearchParams,
  material: string,
  inj: AuthInjection,
): void {
  if (inj.location === 'query') {
    query.set(inj.name, material);
    return;
  }
  if (inj.cookieName) {
    mergeCookiePair(headers, inj.cookieName, material);
    return;
  }
  if (inj.scheme === 'bearer') {
    setHeader(headers, inj.name, `Bearer ${material}`);
    return;
  }
  if (inj.scheme === 'basic') {
    setHeader(headers, inj.name, basicValue(material));
    return;
  }
  setHeader(headers, inj.name, material);
}
