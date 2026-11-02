// OpenAPI 3.x importer — parses a spec object (or fetches one from a URL)
// into operation records + an agent-readiness inventory (ANA-01).

import { createHash } from 'node:crypto';
import { fetchWithEgress } from './egress.js';

export interface ParsedParameter {
  name: string;
  location: 'path' | 'query' | 'header' | 'cookie';
  required: boolean;
  type: string;
  description: string;
  default?: unknown;
  example?: unknown;
  /** Spec hints the eval harness uses to build realistic arguments. */
  enum?: unknown[];
  format?: string;
  minimum?: number;
  maximum?: number;
}

export interface ParsedOperation {
  method: string;
  path: string;
  operationId?: string;
  summary: string;
  description: string;
  parameters: ParsedParameter[];
  requestBodySchema?: unknown;
  responseCodes: string[];
  hasErrorResponses: boolean;
  deprecated: boolean;
  authSchemes: string[];
  /** Union of OAuth scopes named by the operation's security requirements (AB-05). */
  authScopes: string[];
  tags: string[];
}

export interface SecuritySchemeDetails {
  /** Declared type: `apiKey` | `http` | `oauth2` | `openIdConnect` | `basic` (Swagger 2.0) | … */
  type: string;
  /** apiKey location: `header` | `query` | `cookie`. */
  in?: string;
  /** apiKey: the header / query-param / cookie name carrying the key. */
  name?: string;
  /** http: the auth scheme (`bearer`, `basic`, …). */
  scheme?: string;
}

export interface ParsedSpec {
  title: string;
  version: string;
  openapiVersion: string;
  baseUrl: string;
  securitySchemes: string[];
  /** Scheme name → declared type (`apiKey` | `http` | `oauth2` | `openIdConnect` | …),
   *  from `components.securitySchemes` (3.x) or `securityDefinitions` (2.0). The
   *  compiler maps these to credential modes (AB-05). */
  securitySchemeTypes: Record<string, string>;
  /** Scheme name → full declared details (AB-02). The compiler freezes the
   *  api_key injection target (header/query/basic) into the tool snapshot
   *  from these, so invoke/eval never re-read the spec at request time. */
  securitySchemeDetails: Record<string, SecuritySchemeDetails>;
  schemaCount: number;
  operations: ParsedOperation[];
  specHash: string;
}

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

function schemaType(s: any): string {
  if (!s || typeof s !== 'object') return 'string';
  if (s.type) return Array.isArray(s.type) ? s.type[0] : s.type;
  if (s.$ref) return 'object';
  if (s.anyOf || s.oneOf) return 'object';
  return 'string';
}

/**
 * OpenAPI `examples` is either a map of `{ value }` objects (parameters)
 * or a plain array (JSON Schema 2020-12). Returns the first usable value.
 */
function firstExampleValue(examples: unknown): unknown {
  if (Array.isArray(examples)) return examples[0];
  if (examples && typeof examples === 'object') {
    for (const ex of Object.values(examples as Record<string, any>)) {
      if (ex && typeof ex === 'object' && 'value' in ex) return ex.value;
    }
  }
  return undefined;
}

/** enum / format / bounds carried through so tools and evals stay faithful to the spec. */
function schemaHints(s: any): Pick<ParsedParameter, 'enum' | 'format' | 'minimum' | 'maximum'> {
  if (!s || typeof s !== 'object') return {};
  return {
    ...(Array.isArray(s.enum) && s.enum.length > 0 ? { enum: s.enum } : {}),
    ...(typeof s.format === 'string' ? { format: s.format } : {}),
    ...(typeof s.minimum === 'number' ? { minimum: s.minimum } : {}),
    ...(typeof s.maximum === 'number' ? { maximum: s.maximum } : {}),
  };
}

// ─── Postman Collection v2.1 → OpenAPI 3.x conversion (IA-02) ───────────────
// Postman Collections are the artifact API owners already have. Following
// the IA-01 call (D-38), we normalize a collection into the OpenAPI 3.x
// shape once, here at the parse entry, so the whole pipeline consumes one
// dialect and stored sources stay byte-identical to the upload. Mapping:
//   nested folders                 → tags (and folder auth inherits down)
//   request method/url/header/body → operations (path `:id`/`{{id}}` params,
//                                    query, header params, JSON bodies
//                                    inferred from the saved example)
//   collection/request auth        → securitySchemes (apikey, bearer,
//                                    basic, oauth2); `noauth` → `security: []`
//   collection variables           → URL substitution for base-url style
//                                    variables ({{baseUrl}} etc.); other
//                                    unresolved {{vars}} become path params
//   saved responses                → response codes (default 200)
// Disabled parameters/headers are skipped. Content-Type / Authorization /
// Cookie headers are not tool arguments — auth is modeled as a scheme.

function pmDescription(d: any): string {
  if (typeof d === 'string') return d;
  if (d && typeof d === 'object' && typeof d.content === 'string') return d.content;
  return '';
}

function pmAuthParams(auth: any): Map<string, string> {
  const out = new Map<string, string>();
  const list = Array.isArray(auth) ? auth : [];
  for (const e of list) {
    if (e && typeof e === 'object' && typeof e.key === 'string') {
      out.set(e.key.toLowerCase(), e.value == null ? '' : String(e.value));
    }
  }
  return out;
}

function pmSchemeForAuth(auth: any): { name: string; def: any; scopes: string[] } | null | 'noauth' {
  if (!auth || typeof auth !== 'object' || typeof auth.type !== 'string') return null;
  const type = auth.type.toLowerCase();
  if (type === 'noauth') return 'noauth';
  const params = pmAuthParams(auth[type] ?? auth.apikey ?? auth.bearer ?? auth.basic ?? auth.oauth2);
  if (type === 'apikey') {
    const keyName = params.get('key') || 'X-API-Key';
    const where = (params.get('in') || 'header').toLowerCase() === 'query' ? 'query' : 'header';
    const name = `ApiKey_${keyName.replace(/[^a-zA-Z0-9]/g, '_')}`;
    return { name, def: { type: 'apiKey', name: keyName, in: where }, scopes: [] };
  }
  if (type === 'bearer') {
    return { name: 'BearerAuth', def: { type: 'http', scheme: 'bearer' }, scopes: [] };
  }
  if (type === 'basic') {
    return { name: 'BasicAuth', def: { type: 'http', scheme: 'basic' }, scopes: [] };
  }
  if (type === 'oauth2') {
    const authUrl = params.get('authurl') || params.get('authorizationurl') || '';
    const tokenUrl = params.get('accesstokenurl') || params.get('tokenurl') || '';
    const scopeStr = params.get('scope') || '';
    const scopes = scopeStr ? scopeStr.split(/[\s,]+/).filter(Boolean) : [];
    const flow: Record<string, unknown> = {};
    if (tokenUrl) flow.tokenUrl = tokenUrl;
    if (authUrl) flow.authorizationUrl = authUrl;
    flow.scopes = Object.fromEntries(scopes.map((s) => [s, '']));
    const grant = (params.get('granttype') || '').toLowerCase();
    const flows = grant.includes('client')
      ? { clientCredentials: flow }
      : { authorizationCode: flow };
    return { name: 'PostmanOAuth2', def: { type: 'oauth2', flows }, scopes };
  }
  // hawk / digest / ntlm / awsv4 etc. have no OpenAPI scheme equivalent —
  // leave the operation unauthenticated rather than inventing one.
  return null;
}

function pmSchemaFromExample(v: unknown): any {
  if (v === null || v === undefined) return { type: 'string' };
  if (Array.isArray(v)) {
    return { type: 'array', items: v.length ? pmSchemaFromExample(v[0]) : {} };
  }
  if (typeof v === 'object') {
    const properties: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      properties[k] = pmSchemaFromExample(val);
    }
    return { type: 'object', properties };
  }
  if (typeof v === 'number') return { type: Number.isInteger(v) ? 'integer' : 'number' };
  if (typeof v === 'boolean') return { type: 'boolean' };
  return { type: 'string' };
}

function pmInferScalarType(value: string): string {
  if (/^-?\d+$/.test(value)) return 'integer';
  if (/^-?\d+\.\d+$/.test(value)) return 'number';
  if (value === 'true' || value === 'false') return 'boolean';
  return 'string';
}

function pmOperationId(name: string, fallback: string): string {
  const parts = name.split(/[^a-zA-Z0-9]+/).filter(Boolean);
  if (parts.length === 0) return fallback;
  const id = parts
    .map((p, i) => (i === 0 ? p.charAt(0).toLowerCase() + p.slice(1) : p.charAt(0).toUpperCase() + p.slice(1)))
    .join('');
  return /^[a-zA-Z]/.test(id) ? id : `op_${id}`;
}

export function isPostmanCollection(doc: any): boolean {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return false;
  if (!Array.isArray(doc.item) || !doc.info || typeof doc.info !== 'object') return false;
  const schema = typeof doc.info.schema === 'string' ? doc.info.schema : '';
  if (schema.includes('getpostman.com/json/collection')) return true;
  // Trimmed exports sometimes drop the schema URL; a collection still
  // announces itself by name + request/folder items and no spec dialect.
  return typeof doc.info.name === 'string' && !doc.openapi && !doc.swagger &&
    doc.item.some((it: any) => it && typeof it === 'object' && ('request' in it || 'item' in it));
}

interface PmResolvedUrl {
  server?: string;
  path: string;
  query: Array<{ key: string; value: string; description: string }>;
  pathParams: Array<{ name: string; description: string }>;
}

function pmResolveUrl(requestUrl: any, vars: Map<string, string>): PmResolvedUrl {
  const substituteBaseVars = (text: string): string =>
    text.replace(/\{\{\s*([^}\s]+)\s*\}\}/g, (m, name: string) => {
      const v = vars.get(name);
      if (v && (/base|host|api.?url|^url$/i.test(name) || /^https?:\/\//i.test(v))) return v;
      return m;
    });
  const placeholder = (text: string): string =>
    text.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_m, name: string) => `__pm_${name.replace(/[^a-zA-Z0-9]/g, '_')}__`);

  let raw = '';
  let structuredQuery: PmResolvedUrl['query'] | null = null;
  let pathVarDesc = new Map<string, string>();

  if (typeof requestUrl === 'string') {
    raw = requestUrl;
  } else if (requestUrl && typeof requestUrl === 'object') {
    if (Array.isArray(requestUrl.variable)) {
      for (const v of requestUrl.variable) {
        if (v && typeof v.key === 'string') pathVarDesc.set(v.key, pmDescription(v.description));
      }
    }
    if (Array.isArray(requestUrl.query)) {
      structuredQuery = requestUrl.query
        .filter((qq: any) => qq && !qq.disabled && typeof qq.key === 'string' && qq.key)
        .map((qq: any) => ({
          key: String(qq.key),
          value: qq.value == null ? '' : String(qq.value),
          description: pmDescription(qq.description),
        }));
    }
    if (typeof requestUrl.raw === 'string' && requestUrl.raw) {
      raw = requestUrl.raw;
    } else {
      // Rebuild from parts: protocol://host.join('.')/path.join('/')
      const protocol = typeof requestUrl.protocol === 'string' ? requestUrl.protocol : 'https';
      const hostParts: string[] = Array.isArray(requestUrl.host)
        ? requestUrl.host.map((h: any) => String(h))
        : requestUrl.host ? [String(requestUrl.host)] : [];
      const hostSub = substituteBaseVars(hostParts.join('.'));
      let serverPrefix = '';
      const pathParts: string[] = Array.isArray(requestUrl.path)
        ? requestUrl.path.map((p: any) => String(p)) : [];
      if (/^https?:\/\//i.test(hostSub)) {
        try {
          const u = new URL(hostSub);
          serverPrefix = u.origin;
          const prefixSegs = u.pathname.split('/').filter(Boolean);
          pathParts.unshift(...prefixSegs);
        } catch { /* fall through with the raw host */ }
      } else if (hostSub) {
        serverPrefix = `${protocol}://${hostSub}`;
      }
      const qs = structuredQuery && structuredQuery.length
        ? `?${structuredQuery.map((qq) => `${encodeURIComponent(qq.key)}=${encodeURIComponent(qq.value)}`).join('&')}`
        : '';
      raw = `${serverPrefix}/${pathParts.join('/')}${qs}`;
    }
  }

  raw = placeholder(substituteBaseVars(raw.trim()));
  let server: string | undefined;
  let pathPart = raw;
  let queryPart = '';
  const qIdx = raw.indexOf('?');
  if (qIdx >= 0) {
    pathPart = raw.slice(0, qIdx);
    queryPart = raw.slice(qIdx + 1);
  }
  let segments: string[] = [];
  const abs = pathPart.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/]*)(.*)$/);
  if (abs) {
    server = `${abs[1]}://${abs[2]}`;
    segments = (abs[3] ?? '').split('/').filter(Boolean);
  } else {
    segments = pathPart.split('/').filter(Boolean);
    if (segments.length > 1 && segments[0].includes('.') && !segments[0].startsWith('__pm_')) {
      server = `https://${segments[0]}`;
      segments = segments.slice(1);
    } else if (segments.length > 0 && segments[0].startsWith('__pm_')) {
      // Unresolved base-url variable as the first segment — not a path part.
      segments = segments.slice(1);
    }
  }

  const pathParams: PmResolvedUrl['pathParams'] = [];
  const seenPath = new Set<string>();
  const outSegments = segments.map((seg) => {
    let out = seg;
    out = out.replace(/__pm_([a-zA-Z0-9_]+)__/g, (_m, name: string) => `{${name}}`);
    out = out.replace(/:([a-zA-Z0-9_]+)/g, (_m, name: string) => `{${name}}`);
    for (const m of out.matchAll(/\{([^}]+)\}/g)) {
      const name = m[1];
      if (!seenPath.has(name)) {
        seenPath.add(name);
        pathParams.push({ name, description: pathVarDesc.get(name) ?? '' });
      }
    }
    return out;
  });

  let query = structuredQuery ?? [];
  if (!structuredQuery && queryPart) {
    const seenQ = new Set<string>();
    for (const [k, v] of new URLSearchParams(queryPart)) {
      if (seenQ.has(k)) continue;
      seenQ.add(k);
      query.push({ key: k, value: v, description: '' });
    }
  }
  // Placeholder values (unresolved {{vars}}) carry no usable example.
  query = query.map((qq) => ({ ...qq, value: qq.value.includes('__pm_') ? '' : qq.value }));

  return { server, path: `/${outSegments.join('/')}`, query, pathParams };
}

function pmRequestBody(body: any): any | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const mode = typeof body.mode === 'string' ? body.mode : '';
  if (mode === 'raw') {
    const rawText = typeof body.raw === 'string' ? body.raw : '';
    if (!rawText.trim()) return undefined;
    const language = typeof body.options?.raw?.language === 'string' ? body.options.raw.language : '';
    const looksJson = language === 'json' || /^\s*[[{]/.test(rawText);
    if (!looksJson) {
      return { content: { 'text/plain': { schema: { type: 'string' } } } };
    }
    // {{variables}} in examples are placeholders — parse around them.
    const sanitized = rawText.replace(/\{\{[^}]+\}\}/g, 'null');
    try {
      const example = JSON.parse(sanitized);
      return { content: { 'application/json': { schema: pmSchemaFromExample(example) } } };
    } catch {
      return { content: { 'application/json': { schema: { type: 'object' } } } };
    }
  }
  if (mode === 'urlencoded' || mode === 'formdata') {
    const entries = Array.isArray(body[mode]) ? body[mode] : [];
    const properties: Record<string, unknown> = {};
    for (const e of entries) {
      if (!e || e.disabled || typeof e.key !== 'string' || !e.key) continue;
      properties[e.key] = e.type === 'file'
        ? { type: 'string', format: 'binary', ...(pmDescription(e.description) ? { description: pmDescription(e.description) } : {}) }
        : { type: 'string', ...(pmDescription(e.description) ? { description: pmDescription(e.description) } : {}) };
    }
    if (Object.keys(properties).length === 0) return undefined;
    const media = mode === 'urlencoded' ? 'application/x-www-form-urlencoded' : 'multipart/form-data';
    return { content: { [media]: { schema: { type: 'object', properties } } } };
  }
  if (mode === 'graphql') {
    return {
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: { query: { type: 'string' }, variables: { type: 'object' } },
          },
        },
      },
    };
  }
  return undefined;
}

/** Normalize a Postman Collection v2.1 into the OpenAPI 3.x shape (IA-02).
 *  Pure: the input is deep-cloned, never mutated. Non-collection input is
 *  returned as-is. Throws when a collection contains no requests. */
export function convertPostmanToOpenApi(doc: any): any {
  if (!isPostmanCollection(doc)) return doc;
  const src = JSON.parse(JSON.stringify(doc)) as any;

  const vars = new Map<string, string>();
  if (Array.isArray(src.variable)) {
    for (const v of src.variable) {
      if (v && typeof v.key === 'string') vars.set(v.key, v.value == null ? '' : String(v.value));
    }
  }

  const versionRaw = src.info?.version;
  const version = typeof versionRaw === 'string'
    ? versionRaw
    : versionRaw && typeof versionRaw === 'object'
      ? [versionRaw.major, versionRaw.minor, versionRaw.patch].filter((n) => n != null).join('.') || '1.0.0'
      : '1.0.0';

  const schemes: Record<string, any> = {};
  const registerScheme = (s: { name: string; def: any } | null | 'noauth') => {
    if (s && s !== 'noauth' && !(s.name in schemes)) schemes[s.name] = s.def;
  };

  interface FlatReq { item: any; request: any; folders: string[]; inheritedAuth: any }
  const flat: FlatReq[] = [];
  const walk = (items: any[], folders: string[], inheritedAuth: any) => {
    for (const item of Array.isArray(items) ? items : []) {
      if (!item || typeof item !== 'object') continue;
      if (Array.isArray(item.item)) {
        walk(item.item, [...folders, typeof item.name === 'string' ? item.name : ''].filter(Boolean), item.auth ?? inheritedAuth);
      } else if ('request' in item) {
        flat.push({ item, request: item.request, folders, inheritedAuth });
      }
    }
  };
  walk(src.item, [], src.auth);
  if (flat.length === 0) throw new Error('Postman collection contains no requests to import');

  const servers: string[] = [];
  const paths: Record<string, any> = {};
  const usedOperationIds = new Set<string>();

  for (const { item, request, folders, inheritedAuth } of flat) {
    const req = typeof request === 'string' ? { method: 'GET', url: request } : (request ?? {});
    const method = String(req.method ?? 'GET').toUpperCase();
    const resolved = pmResolveUrl(req.url, vars);
    if (resolved.server && !servers.includes(resolved.server)) servers.push(resolved.server);

    const parameters: any[] = [];
    for (const pp of resolved.pathParams) {
      parameters.push({
        name: pp.name, in: 'path', required: true,
        ...(pp.description ? { description: pp.description } : {}),
        schema: { type: 'string' },
      });
    }
    for (const qq of resolved.query) {
      parameters.push({
        name: qq.key, in: 'query', required: false,
        ...(qq.description ? { description: qq.description } : {}),
        schema: {
          type: pmInferScalarType(qq.value || 'string') === 'string' && !qq.value
            ? 'string' : pmInferScalarType(qq.value),
          ...(qq.value ? { example: qq.value } : {}),
        },
      });
    }
    // Headers: array form (v2.1) or the legacy raw-string block.
    const headerEntries: Array<{ key: string; value: string; description: string }> = [];
    if (Array.isArray(req.header)) {
      for (const h of req.header) {
        if (!h || h.disabled || typeof h.key !== 'string' || !h.key) continue;
        headerEntries.push({ key: h.key, value: h.value == null ? '' : String(h.value), description: pmDescription(h.description) });
      }
    } else if (typeof req.header === 'string') {
      for (const line of req.header.split('\n')) {
        const idx = line.indexOf(':');
        if (idx > 0) headerEntries.push({ key: line.slice(0, idx).trim(), value: line.slice(idx + 1).trim(), description: '' });
      }
    }
    let headerAuth: ReturnType<typeof pmSchemeForAuth> = null;
    for (const h of headerEntries) {
      const lower = h.key.toLowerCase();
      if (lower === 'authorization') {
        if (/^bearer\b/i.test(h.value)) headerAuth = { name: 'BearerAuth', def: { type: 'http', scheme: 'bearer' }, scopes: [] };
        else if (/^basic\b/i.test(h.value)) headerAuth = { name: 'BasicAuth', def: { type: 'http', scheme: 'basic' }, scopes: [] };
        continue;
      }
      if (lower === 'content-type' || lower === 'cookie' || lower === 'accept') continue;
      parameters.push({
        name: h.key, in: 'header', required: false,
        ...(h.description ? { description: h.description } : {}),
        schema: { type: 'string', ...(h.value && !h.value.includes('{{') ? { example: h.value } : {}) },
      });
    }

    const auth = pmSchemeForAuth(req.auth ?? inheritedAuth) ?? headerAuth;
    registerScheme(auth && auth !== 'noauth' ? auth : null);
    let security: any[] | undefined;
    if (auth === 'noauth') security = [];
    else if (auth) security = [{ [auth.name]: auth.scopes }];

    const responses: Record<string, any> = {};
    if (Array.isArray(item.response)) {
      for (const r of item.response) {
        const code = r && (typeof r.code === 'number' || typeof r.code === 'string') ? String(r.code) : '';
        if (code && !(code in responses)) {
          responses[code] = { description: String(r.name ?? r.status ?? 'Saved example') };
        }
      }
    }
    if (Object.keys(responses).length === 0) responses['200'] = { description: 'Successful response' };

    const itemName = typeof item.name === 'string' && item.name.trim() ? item.name.trim() : `${method} ${resolved.path}`;
    let operationId = pmOperationId(itemName, `${method.toLowerCase()}Request`);
    if (usedOperationIds.has(operationId)) {
      let n = 2;
      while (usedOperationIds.has(`${operationId}${n}`)) n += 1;
      operationId = `${operationId}${n}`;
    }
    usedOperationIds.add(operationId);

    const requestBody = pmRequestBody(req.body);
    paths[resolved.path] ??= {};
    if (paths[resolved.path][method.toLowerCase()]) continue; // first request wins on duplicates
    paths[resolved.path][method.toLowerCase()] = {
      operationId,
      summary: itemName,
      ...(pmDescription(req.description) ? { description: pmDescription(req.description) } : {}),
      ...(folders.length ? { tags: [folders.join(' / ')] } : {}),
      parameters,
      ...(requestBody ? { requestBody } : {}),
      responses,
      ...(security ? { security } : {}),
    };
  }

  const collectionAuth = pmSchemeForAuth(src.auth);
  registerScheme(collectionAuth && collectionAuth !== 'noauth' ? collectionAuth : null);

  return {
    openapi: '3.0.3',
    info: {
      title: String(src.info?.name ?? 'Postman Collection'),
      version,
      ...(pmDescription(src.info?.description) ? { description: pmDescription(src.info.description) } : {}),
    },
    ...(servers.length ? { servers: servers.map((url) => ({ url })) } : {}),
    paths,
    components: { securitySchemes: schemes },
    ...(collectionAuth && collectionAuth !== 'noauth' ? { security: [{ [collectionAuth.name]: collectionAuth.scopes }] } : {}),
  };
}


// Swagger 2.0 is a locked v1 input (PF-06). Rather than teaching every stage
// two dialects, we normalize a 2.0 document into the 3.x shape once, here at
// the parse entry, and the whole pipeline (compiler, eval, broker) consumes
// the result. The conversion is structural:
//   host/basePath/schemes        → servers[]
//   definitions                  → components.schemas ($refs rewritten)
//   parameters / responses       → components.parameters / components.responses
//   securityDefinitions          → components.securitySchemes (basic→http,
//                                  oauth2 flow names mapped to 3.x)
//   in: body parameters          → requestBody (application/json)
//   in: formData parameters      → requestBody (urlencoded form schema)
// The source document is never mutated; the converter deep-clones first.

function rewriteRefs(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(rewriteRefs);
  if (node && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === '$ref' && typeof v === 'string') {
        out[k] = v
          .replace(/^#\/definitions\//, '#/components/schemas/')
          .replace(/^#\/parameters\//, '#/components/parameters/')
          .replace(/^#\/responses\//, '#/components/responses/');
      } else {
        out[k] = rewriteRefs(v);
      }
    }
    return out;
  }
  return node;
}

function convertSecurityScheme(def: any): any {
  if (!def || typeof def !== 'object') return def;
  if (def.type === 'basic') return { type: 'http', scheme: 'basic', ...(def.description ? { description: def.description } : {}) };
  if (def.type === 'apiKey') return { type: 'apiKey', name: def.name, in: def.in, ...(def.description ? { description: def.description } : {}) };
  if (def.type === 'oauth2') {
    const flows: Record<string, unknown> = {};
    const base = { authorizationUrl: def.authorizationUrl, tokenUrl: def.tokenUrl, scopes: def.scopes ?? {} };
    if (def.flow === 'implicit') flows.implicit = base;
    else if (def.flow === 'accessCode') flows.authorizationCode = base;
    else if (def.flow === 'application') flows.clientCredentials = { tokenUrl: def.tokenUrl, scopes: def.scopes ?? {} };
    else if (def.flow === 'password') flows.password = { tokenUrl: def.tokenUrl, scopes: def.scopes ?? {} };
    return { type: 'oauth2', flows, ...(def.description ? { description: def.description } : {}) };
  }
  return def;
}

function convertedRequestBody(op: any, spec: any): { requestBody?: any; parameters: any[] } {
  const params: any[] = Array.isArray(op.parameters) ? op.parameters : [];
  const kept: any[] = [];
  let bodyParam: any = null;
  const formParams: any[] = [];
  for (const p of params) {
    if (p && p.in === 'body') bodyParam = p;
    else if (p && p.in === 'formData') formParams.push(p);
    else kept.push(p);
  }
  if (!bodyParam && formParams.length === 0) return { parameters: kept };
  if (bodyParam) {
    const consumes: string[] = op.consumes ?? spec.consumes ?? ['application/json'];
    const media = consumes.find((c) => c.includes('json')) ?? 'application/json';
    return {
      requestBody: {
        required: Boolean(bodyParam.required),
        ...(bodyParam.description ? { description: bodyParam.description } : {}),
        content: { [media]: { schema: bodyParam.schema ?? {} } },
      },
      parameters: kept,
    };
  }
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const p of formParams) {
    properties[p.name] = { type: p.type === 'file' ? 'string' : (p.type ?? 'string'), ...(p.description ? { description: p.description } : {}) };
    if (p.required) required.push(p.name);
  }
  return {
    requestBody: {
      content: { 'application/x-www-form-urlencoded': { schema: { type: 'object', properties, ...(required.length ? { required } : {}) } } },
    },
    parameters: kept,
  };
}

/** Normalize a Swagger 2.0 document into the OpenAPI 3.x shape (IA-01). Pure:
 *  the input is deep-cloned, never mutated. Non-2.0 input is returned as-is. */
export function convertSwaggerToOpenApi(spec: any): any {
  if (!spec || typeof spec !== 'object' || typeof spec.swagger !== 'string' || !spec.swagger.startsWith('2.')) {
    return spec;
  }
  const src = rewriteRefs(JSON.parse(JSON.stringify(spec))) as any;
  const schemes: string[] = Array.isArray(src.schemes) && src.schemes.length ? src.schemes : ['https'];
  const host = typeof src.host === 'string' ? src.host : '';
  const basePath = typeof src.basePath === 'string' ? src.basePath : '';
  const out: any = {
    openapi: '3.0.3',
    info: src.info ?? {},
    ...(host ? { servers: schemes.map((s) => ({ url: `${s}://${host}${basePath}` })) } : {}),
    paths: {},
    components: {
      ...(src.definitions ? { schemas: src.definitions } : {}),
      ...(src.parameters ? { parameters: src.parameters } : {}),
      ...(src.responses ? { responses: src.responses } : {}),
      ...(src.securityDefinitions
        ? { securitySchemes: Object.fromEntries(Object.entries(src.securityDefinitions).map(([k, v]) => [k, convertSecurityScheme(v)])) }
        : {}),
    },
    ...(Array.isArray(src.security) ? { security: src.security } : {}),
    ...(Array.isArray(src.tags) ? { tags: src.tags } : {}),
  };
  for (const [path, pathItem] of Object.entries<any>(src.paths ?? {})) {
    if (!pathItem || typeof pathItem !== 'object') continue;
    const convertedItem: any = {};
    for (const [key, value] of Object.entries<any>(pathItem)) {
      if (HTTP_METHODS.includes(key) && value && typeof value === 'object') {
        const { requestBody, parameters } = convertedRequestBody(value, src);
        convertedItem[key] = { ...value, parameters, ...(requestBody ? { requestBody } : {}) };
        delete convertedItem[key].consumes;
        delete convertedItem[key].produces;
      } else {
        convertedItem[key] = value;
      }
    }
    out.paths[path] = convertedItem;
  }
  return out;
}

/**
 * The first server's URL as an absolute base: `{variables}` take their
 * declared defaults, and a relative URL ("/api/v3", common in published
 * specs) resolves against the address the document was fetched from, as
 * the OpenAPI spec defines. Unresolvable relative URLs stay as written
 * (the inventory flags them).
 */
export function resolveServerUrl(server: any, documentUrl?: string): string {
  let url = String(server?.url ?? '');
  const vars = server?.variables && typeof server.variables === 'object' ? server.variables : {};
  url = url.replace(/\{([^}]+)\}/g, (m, name) => (vars[name]?.default !== undefined ? String(vars[name].default) : m));
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url) && documentUrl && /^https?:\/\//i.test(documentUrl)) {
    try { url = new URL(url || '/', documentUrl).toString(); } catch { /* keep as written */ }
  }
  return url.replace(/\/$/, '');
}

export function parseOpenApi(spec: any, documentUrl?: string): ParsedSpec {
  // IA-02: Postman Collections are normalized to 3.x here, same as Swagger.
  spec = convertPostmanToOpenApi(spec);
  // IA-01: Swagger 2.0 documents are normalized to 3.x here so every
  // downstream stage sees exactly one dialect.
  spec = convertSwaggerToOpenApi(spec);
  if (!spec || typeof spec !== 'object') throw new Error('Spec must be a JSON object');
  const openapiVersion: string = spec.openapi ?? spec.swagger ?? '';
  if (!openapiVersion.startsWith('3.') && !openapiVersion.startsWith('2.')) {
    throw new Error(`Unsupported spec version: ${openapiVersion || 'unknown'} (need OpenAPI 3.x or Swagger 2.0)`);
  }
  const servers: any[] = spec.servers ?? [];
  const host = spec.host;
  const basePath = spec.basePath ?? '';
  const scheme = Array.isArray(spec.schemes) && spec.schemes.length ? spec.schemes[0] : 'https';
  const baseUrl = servers.length && servers[0].url
    ? resolveServerUrl(servers[0], documentUrl)
    : host ? `${scheme}://${host}${basePath}` : '';

  const schemeDefs: Record<string, any> = spec.components?.securitySchemes
    ?? spec.securityDefinitions ?? {};
  const securitySchemes = Object.keys(schemeDefs);
  const securitySchemeTypes: Record<string, string> = {};
  const securitySchemeDetails: Record<string, SecuritySchemeDetails> = {};
  for (const [name, def] of Object.entries(schemeDefs)) {
    if (def && typeof def === 'object' && typeof (def as any).type === 'string') {
      securitySchemeTypes[name] = (def as any).type;
      const d: SecuritySchemeDetails = { type: (def as any).type };
      if (typeof (def as any).in === 'string') d.in = (def as any).in;
      if (typeof (def as any).name === 'string') d.name = (def as any).name;
      if (typeof (def as any).scheme === 'string') d.scheme = (def as any).scheme;
      securitySchemeDetails[name] = d;
    }
  }
  // Global security applies to every operation that doesn't declare its own
  // (an explicit `security: []` on an operation means "no auth" and wins).
  const globalSecurity: any[] = Array.isArray(spec.security) ? spec.security : [];
  const schemaCount = spec.components?.schemas ? Object.keys(spec.components.schemas).length
    : spec.definitions ? Object.keys(spec.definitions).length : 0;

  const operations: ParsedOperation[] = [];
  const paths = spec.paths ?? {};
  for (const [path, pathItem] of Object.entries<any>(paths)) {
    if (!pathItem || typeof pathItem !== 'object') continue;
    for (const method of HTTP_METHODS) {
      const op = pathItem[method];
      if (!op || typeof op !== 'object') continue;
      const params: ParsedParameter[] = [];
      const allParams = [...(pathItem.parameters ?? []), ...(op.parameters ?? [])];
      for (const p of allParams) {
        if (!p || typeof p !== 'object' || !p.name) continue;
        params.push({
          name: String(p.name),
          location: p.in === 'path' ? 'path' : p.in === 'query' ? 'query' : p.in === 'header' ? 'header' : 'cookie',
          required: p.in === 'path' ? true : Boolean(p.required),
          type: schemaType(p.schema ?? p),
          description: String(p.description ?? ''),
          default: p.schema?.default ?? p.default,
          example: p.schema?.example ?? p.example ?? firstExampleValue(p.examples) ?? firstExampleValue(p.schema?.examples),
          ...schemaHints(p.schema ?? p),
        });
      }
      // Dedupe by name+location (path-level + op-level merges)
      const seen = new Set<string>();
      const deduped = params.filter((p) => {
        const k = `${p.location}:${p.name}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      const responseCodes = Object.keys(op.responses ?? {});
      const securityReq: any[] = Array.isArray(op.security) ? op.security : globalSecurity;
      const authSchemes: string[] = [];
      const scopeSet = new Set<string>();
      for (const req of securityReq) {
        if (!req || typeof req !== 'object') continue;
        for (const [scheme, scopes] of Object.entries<any>(req)) {
          authSchemes.push(scheme);
          if (Array.isArray(scopes)) for (const s of scopes) scopeSet.add(String(s));
        }
      }
      operations.push({
        method: method.toUpperCase(),
        path,
        operationId: op.operationId,
        summary: String(op.summary ?? ''),
        description: String(op.description ?? ''),
        parameters: deduped,
        requestBodySchema: op.requestBody?.content?.['application/json']?.schema,
        responseCodes,
        hasErrorResponses: responseCodes.some((c) => c.startsWith('4') || c.startsWith('5') || c === 'default'),
        deprecated: Boolean(op.deprecated),
        authSchemes,
        authScopes: [...scopeSet],
        tags: op.tags ?? [],
      });
    }
  }

  const specHash = createHash('sha256').update(JSON.stringify(spec)).digest('hex');
  return {
    title: String(spec.info?.title ?? 'Untitled API'),
    version: String(spec.info?.version ?? '1.0.0'),
    openapiVersion,
    baseUrl,
    securitySchemes,
    securitySchemeTypes,
    securitySchemeDetails,
    schemaCount,
    operations,
    specHash,
  };
}

export async function fetchSpec(url: string): Promise<any> {
  // SE-08 (F-3): spec/collection import was the timeout-less, unbounded
  // SSRF path. It now goes through the shared egress policy — scheme +
  // private-address checks (per redirect hop), size cap — plus the
  // 15s timeout eval's probes already had.
  const res = await fetchWithEgress(url, { headers: { accept: 'application/json' } }, { timeoutMs: 15000 });
  if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('URL did not return JSON — YAML specs are not supported in the prototype');
  }
}

// ─── Inventory (ANA-01): gaps, risk, confidence ──────────────────────────────

export type Effect = 'READ' | 'WRITE' | 'DESTRUCTIVE' | 'UNKNOWN';

export function classifyEffect(method: string, path: string): Effect {
  const m = method.toUpperCase();
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return 'READ';
  if (m === 'DELETE') return 'DESTRUCTIVE';
  if (m === 'POST' || m === 'PUT' || m === 'PATCH') return 'WRITE';
  return 'UNKNOWN';
}

export function docScore(op: ParsedOperation): number {
  let s = 0;
  if (op.summary) s += 25;
  if (op.description) s += 20;
  if (op.operationId) s += 10;
  const withDesc = op.parameters.filter((p) => p.description).length;
  if (op.parameters.length === 0 || withDesc === op.parameters.length) s += 25;
  else if (withDesc > 0) s += 12;
  if (op.hasErrorResponses) s += 20;
  return Math.min(100, s);
}

export interface InventoryFinding {
  code: 'SCHEMA' | 'HOST' | 'EFFECT' | 'ERROR' | 'AUTH';
  severity: 'blocker' | 'warning';
  title: string;
  detail: string;
  operationRef?: string;
}

export function buildInventory(spec: ParsedSpec): { findings: InventoryFinding[] } {
  const findings: InventoryFinding[] = [];
  if (!spec.baseUrl) {
    findings.push({
      code: 'HOST', severity: 'blocker', title: 'No server URL in spec',
      detail: 'The spec defines no servers/host. The sandbox prober cannot reach this API until a base URL is provided.',
    });
  }
  if (spec.securitySchemes.length === 0) {
    findings.push({
      code: 'AUTH', severity: 'warning', title: 'No security schemes declared',
      detail: 'Treating all operations as unauthenticated. If the API requires auth, declare securitySchemes.',
    });
  }
  for (const op of spec.operations) {
    const ref = `${op.method} ${op.path}`;
    if (!op.summary && !op.description) {
      findings.push({
        code: 'SCHEMA', severity: 'warning', title: 'Undocumented operation',
        detail: 'No summary or description — the agent-facing description will be inferred from the path.',
        operationRef: ref,
      });
    }
    if (!op.hasErrorResponses) {
      findings.push({
        code: 'ERROR', severity: 'warning', title: 'No documented error responses',
        detail: 'Only success responses are documented. Recovery rules will be inferred from live probing.',
        operationRef: ref,
      });
    }
    const effect = classifyEffect(op.method, op.path);
    if (effect === 'DESTRUCTIVE' || effect === 'WRITE') {
      findings.push({
        code: 'EFFECT', severity: effect === 'DESTRUCTIVE' ? 'blocker' : 'warning',
        title: `${effect === 'DESTRUCTIVE' ? 'Destructive' : 'Mutating'} operation requires a decision`,
        detail: `${ref} will need an explicit confirmation rule and customer approval before release.`,
        operationRef: ref,
      });
    }
  }
  return { findings };
}
