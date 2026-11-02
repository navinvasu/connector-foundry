// Action compiler (ACT-01) — proposes canonical tools from parsed operations.
// Deterministic heuristics for the prototype (no LLM): the service proposes,
// the customer approves. Every generated field records provenance.

import { ParsedOperation, classifyEffect, docScore, type SecuritySchemeDetails } from './openapi.js';
import type { AuthInjection } from './broker/inject.js';

export interface CompiledTool {
  name: string;
  description: string;
  purpose: string;
  eligible_use: string;
  ineligible_use: string;
  input_schema: unknown;
  output_schema: unknown;
  upstream: unknown;
  effect_classes: string[];
  confirmation_required: boolean;
  idempotent: boolean;
  credential_mode: string | null;
  required_scopes: string[];
  provenance: Array<{ kind: string; ref: string }>;
  confidence: number;
  recovery_rules: Array<{
    condition: string;
    detection_rule: unknown;
    behavior: string;
    recovery_action: string | null;
    max_attempts: number;
    backoff_ms: number;
    user_message: string;
  }>;
}

function toCamel(s: string): string {
  return s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

function toolName(op: ParsedOperation): string {
  if (op.operationId) return toCamel(op.operationId.replace(/[^a-zA-Z0-9_]/g, '_'));
  const parts = op.path.split('/').filter(Boolean).map((p) => p.replace(/[{}]/g, ''));
  const resource = parts.filter((p) => !/^(v\d+|api)$/i.test(p)).join('_') || 'resource';
  const verb = op.method === 'GET' ? 'get' : op.method === 'POST' ? 'create' : op.method.toLowerCase();
  return toCamel(`${verb}_${resource}`.replace(/[^a-zA-Z0-9_]/g, '_'));
}

function jsonType(t: string): string {
  const m: Record<string, string> = {
    string: 'string', integer: 'integer', number: 'number', boolean: 'boolean',
    array: 'array', object: 'object',
  };
  return m[t] ?? 'string';
}

/**
 * BE-16: a body property schema is already JSON Schema, so keep it as-is
 * (nested properties, enums, formats survive for the output adapters) and
 * only guarantee a usable `type`. A non-object schema node degrades to a
 * plain string field.
 */
function bodyPropertySchema(prop: unknown): Record<string, unknown> {
  if (!prop || typeof prop !== 'object' || Array.isArray(prop)) return { type: 'string' };
  const p = prop as Record<string, unknown>;
  const rawType = typeof p.type === 'string' ? p.type
    : p.properties ? 'object' : p.items !== undefined ? 'array' : 'string';
  return { ...p, type: jsonType(rawType) };
}

/**
 * BE-16: fold the operation's JSON request body into the tool's arguments.
 * Object schemas merge property-by-property (each becomes an arg with a
 * `body` binding to the original field name; the schema's `required`
 * list carries over). Anything else — free-form object, array, primitive,
 * or an unresolved `$ref` — becomes a single whole-body arg bound with an
 * empty target. When a body field's arg name collides with a parameter
 * arg, the body arg is renamed `body<Field>` (counter-suffixed if needed)
 * so neither binding is silently dropped.
 * Returns true when at least one body binding was added.
 */
function mergeBodyArguments(
  requestBodySchema: unknown,
  properties: Record<string, unknown>,
  required: string[],
  bindings: Array<{ arg: string; location: string; target: string }>,
): boolean {
  if (!requestBodySchema || typeof requestBodySchema !== 'object' || Array.isArray(requestBodySchema)) {
    return false;
  }
  const schema = requestBodySchema as Record<string, any>;
  const props = schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties)
    ? (schema.properties as Record<string, unknown>)
    : null;

  if (props && Object.keys(props).length > 0) {
    const bodyRequired: string[] = Array.isArray(schema.required) ? schema.required.map(String) : [];
    for (const [propName, propSchema] of Object.entries(props)) {
      let arg = toCamel(propName.replace(/[^a-zA-Z0-9_]/g, '_')) || 'bodyField';
      if (arg in properties) {
        const base = `body${arg.charAt(0).toUpperCase()}${arg.slice(1)}`;
        arg = base;
        let n = 2;
        while (arg in properties) { arg = `${base}${n}`; n += 1; }
      }
      properties[arg] = bodyPropertySchema(propSchema);
      if (bodyRequired.includes(propName)) required.push(arg);
      bindings.push({ arg, location: 'body', target: propName });
    }
    return true;
  }

  // Whole-body fallback: the caller supplies the body as one value.
  let arg = 'body';
  if (arg in properties) {
    arg = 'requestBody';
    let n = 2;
    while (arg in properties) { arg = `requestBody${n}`; n += 1; }
  }
  const rawType = typeof schema.type === 'string' ? schema.type
    : schema.items !== undefined ? 'array' : 'object';
  properties[arg] = {
    type: jsonType(rawType),
    description: 'The request body (JSON), supplied as a single value.',
  };
  bindings.push({ arg, location: 'body', target: '' });
  return true;
}

export type CredentialMode = 'none' | 'api_key' | 'oauth';

/**
 * AB-05: derive a tool's credential requirement from the operation's
 * security requirements, so the mode is explicit from compile onward and
 * eval / release / invoke can enforce it instead of guessing.
 *
 * Scheme-type mapping (OpenAPI 3.x types + Swagger 2.0's `basic`):
 * `oauth2`/`openIdConnect` → `oauth`; `apiKey`/`http`/`basic` → `api_key`
 * (a static credential the broker will attach per project, AB-02). A scheme
 * the spec *requires* but never defines still means auth is required —
 * conservatively `api_key`. When several schemes apply, `oauth` wins: it is
 * the stricter requirement (a per-user connected account, AB-03).
 */
export function credentialFor(
  op: ParsedOperation,
  schemeTypes: Record<string, string> = {},
): { credential_mode: CredentialMode; required_scopes: string[] } {
  let mode: CredentialMode = 'none';
  for (const name of op.authSchemes) {
    const type = (schemeTypes[name] ?? '').toLowerCase();
    const m: CredentialMode = type === 'oauth2' || type === 'openidconnect' ? 'oauth' : 'api_key';
    if (m === 'oauth') mode = 'oauth';
    else if (mode === 'none') mode = m;
  }
  return {
    credential_mode: mode,
    required_scopes: mode === 'oauth' ? [...new Set(op.authScopes)] : [],
  };
}

/**
 * AB-02: derive the key-injection target for an api_key tool from the spec's
 * declared security scheme, frozen into the immutable tool snapshot
 * (`tool.upstream.auth_injection`). Runtime and eval inject from the
 * snapshot — they never re-read the spec at request time (D-34).
 *
 * Priority mirrors credentialFor: the first api_key-mapped scheme in the
 * operation's security order wins (oauth schemes are skipped — they are
 * not key-injectable). A required-but-undefined scheme maps to the
 * conventional X-API-Key header default.
 */
export function authInjectionForScheme(
  op: ParsedOperation,
  schemeTypes: Record<string, string> = {},
  schemeDetails: Record<string, SecuritySchemeDetails> = {},
): AuthInjection | null {
  for (const name of op.authSchemes) {
    const type = (schemeTypes[name] ?? '').toLowerCase();
    if (type === 'oauth2' || type === 'openidconnect') continue;
    const d = schemeDetails[name];
    const where = d?.in?.toLowerCase();
    const httpScheme = d?.scheme?.toLowerCase();
    // Swagger 2.0 `basic` and OpenAPI `http` + `basic`: key as username.
    if (type === 'basic' || httpScheme === 'basic') {
      return { location: 'header', name: 'Authorization', scheme: 'basic' };
    }
    // OpenAPI `http` (bearer or anything else): Authorization header.
    if (type === 'http') {
      return { location: 'header', name: 'Authorization', scheme: 'bearer' };
    }
    // OpenAPI `apiKey`: declared location wins.
    if (type === 'apikey') {
      if (where === 'query') return { location: 'query', name: d?.name || 'api_key' };
      if (where === 'cookie') return { location: 'header', name: 'Cookie', cookieName: d?.name || 'api_key' };
      return { location: 'header', name: d?.name || 'X-API-Key' };
    }
    // Required-but-undefined scheme: conventional default.
    return { location: 'header', name: 'X-API-Key' };
  }
  return null;
}

export function compileOperation(
  op: ParsedOperation,
  baseUrl: string,
  specRef: string,
  schemeTypes: Record<string, string> = {},
  schemeDetails: Record<string, SecuritySchemeDetails> = {},
): CompiledTool {
  const effect = classifyEffect(op.method, op.path);
  const effectClass = effect === 'READ' ? 'read_only' : effect === 'WRITE' ? 'mutating'
    : effect === 'DESTRUCTIVE' ? 'destructive' : 'read_only';

  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  const bindings: Array<{ arg: string; location: string; target: string }> = [];
  for (const p of op.parameters) {
    const arg = toCamel(p.name.replace(/[^a-zA-Z0-9_]/g, '_'));
    properties[arg] = {
      type: jsonType(p.type),
      description: p.description || `Upstream parameter "${p.name}"`,
      ...(p.default !== undefined ? { default: p.default } : {}),
      ...(p.example !== undefined ? { examples: [p.example] } : {}),
      ...(p.enum ? { enum: p.enum } : {}),
      ...(p.format ? { format: p.format } : {}),
      ...(p.minimum !== undefined ? { minimum: p.minimum } : {}),
      ...(p.maximum !== undefined ? { maximum: p.maximum } : {}),
    };
    if (p.required) required.push(arg);
    bindings.push({ arg, location: p.location, target: p.name });
  }
  // BE-16: request bodies become tool arguments too — without this, a
  // compiled POST/PUT tool could never send the payload it exists to send.
  const hasBodyArgs = mergeBodyArguments(op.requestBodySchema, properties, required, bindings);

  const summary = op.summary || op.description || `${op.method} ${op.path}`;
  const { credential_mode, required_scopes } = credentialFor(op, schemeTypes);
  // AB-02: freeze the key-injection target into the snapshot for api_key
  // tools (D-34). Pre-AB-02 snapshots lack it — the broker falls back to
  // the X-API-Key header default (D-35).
  const authInjection = credential_mode === 'api_key'
    ? authInjectionForScheme(op, schemeTypes, schemeDetails)
    : null;
  const description = op.description || op.summary || `Calls ${op.method} ${op.path}.`;
  const name = toolName(op);

  const recovery_rules: CompiledTool['recovery_rules'] = [
    {
      condition: 'RATE_LIMITED',
      detection_rule: { status_code: 429 },
      behavior: 'retry_changed',
      recovery_action: 'backoff_retry',
      max_attempts: 3,
      backoff_ms: 2000,
      user_message: 'The API asked us to slow down. I waited and tried again.',
    },
    {
      condition: 'UPSTREAM_ERROR',
      detection_rule: { status_code_range: '5xx' },
      behavior: 'retry_changed',
      recovery_action: 'retry_once',
      max_attempts: 2,
      backoff_ms: 1000,
      user_message: 'The API had a temporary problem. I tried once more.',
    },
    {
      condition: 'BAD_REQUEST',
      detection_rule: { status_code_range: '4xx' },
      behavior: 'escalate_user',
      recovery_action: null,
      max_attempts: 1,
      backoff_ms: 0,
      user_message: 'The request was rejected. Please check the inputs and try again.',
    },
    {
      condition: 'EMPTY_RESULT',
      detection_rule: { status_code: 200, empty_results_array: true },
      behavior: 'escalate_user',
      recovery_action: null,
      max_attempts: 1,
      backoff_ms: 0,
      user_message: 'The search came back empty. Check the spelling or try a different value.',
    },
  ];

  return {
    name,
    description,
    purpose: summary,
    eligible_use: `Use when the user asks for: ${summary.toLowerCase()}.`,
    ineligible_use: effectClass === 'read_only'
      ? 'Do not use for anything that changes data — this tool only reads.'
      : 'Do not use outside the approved task scope; confirm with the user before mutating data.',
    input_schema: { type: 'object', properties, required },
    output_schema: { type: 'object', description: 'Normalized upstream response' },
    upstream: {
      method: op.method,
      path_template: op.path,
      base_url: baseUrl,
      param_bindings: bindings,
      ...(authInjection ? { auth_injection: authInjection } : {}),
    },
    effect_classes: [effectClass],
    confirmation_required: effectClass !== 'read_only',
    idempotent: op.method === 'GET' || op.method === 'PUT' || op.method === 'DELETE',
    credential_mode,
    required_scopes,
    provenance: [
      { kind: 'spec', ref: `${specRef}#${op.method} ${op.path}` },
      { kind: 'rule', ref: 'compiler-heuristics-v0 (effect classification, naming, recovery defaults)' },
      ...(credential_mode !== 'none'
        ? [{ kind: 'rule', ref: `credential-mode-v1 (spec security → ${credential_mode})` }]
        : []),
      ...(hasBodyArgs
        ? [{ kind: 'rule', ref: 'request-body-v1 (request body schema → tool arguments)' }]
        : []),
    ],
    confidence: docScore(op),
    recovery_rules,
  };
}
