// OpenAI output artifacts (RL-04): the second v1 output adapter (PF-08).
//
// RL-03 made every approved release a hosted MCP server for Claude; this
// module makes the same frozen release usable from the OpenAI ecosystem:
//
//   1. Function-calling tool schemas — the `tools` array a developer
//      passes to the OpenAI API (`{type:'function', function:{…}}`),
//      generated from the release's frozen tool snapshots.
//   2. A GPT Actions OpenAPI document — one POST operation per tool,
//      served against the Foundry GPT-actions execution surface
//      (`POST /v1/gpt-actions/:projectId/:version/:toolName`, gateway-key
//      auth), so a custom GPT can call the connector with no glue code.
//
// Both artifacts derive from the frozen release_tools snapshots — never
// from the live canonical_tools rows — so what a customer downloads is
// exactly what eval certified and the release signed. Neither artifact
// ever carries a credential: auth is a declared scheme (the caller
// supplies their own DP-07 gateway key), and the validators below fail
// loudly if a gateway-key shape ever appears in generated output.

import { one, q, J } from './db.js';
import { HttpError } from './errors.js';
import { agentDescription } from './tool-text.js';

/** OpenAI function/tool names: 1–64 chars of [a-zA-Z0-9_-]. */
export const OPENAI_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * Map a frozen tool name to a valid OpenAI function name. Compiler names
 * are already snake_case, so this is a defensive normalizer: invalid
 * characters become `_`, the result is trimmed and truncated, and an
 * empty result falls back to `tool`.
 */
export function sanitizeOpenAiName(raw: unknown): string {
  const cleaned = String(raw ?? '')
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
  return cleaned.length > 0 ? cleaned : 'tool';
}

/**
 * Ensure a set of names is unique (OpenAI rejects duplicate function
 * names in one tools array; OpenAPI rejects duplicate operationIds).
 * Later collisions gain a `_2`, `_3`, … suffix within the 64-char cap.
 */
export function dedupeNames(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((n) => {
    const count = (seen.get(n) ?? 0) + 1;
    seen.set(n, count);
    if (count === 1) return n;
    const suffix = `_${count}`;
    return n.slice(0, 64 - suffix.length) + suffix;
  });
}

/**
 * Normalize a frozen input_schema into an OpenAI `parameters` object:
 * a JSON Schema object with `type:'object'`. Property schemas are kept
 * verbatim (the customer approved exactly these); only the envelope is
 * repaired — a missing type becomes `object`, an object schema without
 * properties gains an empty map, and a `$schema` dialect marker (which
 * OpenAI's validator rejects) is dropped.
 */
export function toParametersSchema(inputSchema: unknown): Record<string, unknown> {
  const raw = inputSchema && typeof inputSchema === 'object' && !Array.isArray(inputSchema)
    ? { ...(inputSchema as Record<string, unknown>) }
    : {};
  delete raw.$schema;
  if (raw.type === undefined) raw.type = 'object';
  if (raw.type === 'object' && raw.properties === undefined) raw.properties = {};
  return raw;
}

export interface OpenAiFunctionTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    /** Always false: frozen schemas are not rewritten to strict mode
     *  (which would require every property required + no extras). */
    strict: false;
  };
}

/** Map one frozen tool snapshot to an OpenAI function-calling tool. */
export function toOpenAiFunction(snapshot: Record<string, any>, name?: string): OpenAiFunctionTool {
  return {
    type: 'function',
    function: {
      name: name ?? sanitizeOpenAiName(snapshot?.name),
      description: agentDescription(snapshot ?? {}),
      parameters: toParametersSchema(snapshot?.input_schema),
      strict: false,
    },
  };
}

/** Build the full function-calling tools array for a release. */
export function buildOpenAiTools(snapshots: Array<Record<string, any>>): OpenAiFunctionTool[] {
  const names = dedupeNames(snapshots.map((s) => sanitizeOpenAiName(s?.name)));
  return snapshots.map((s, i) => toOpenAiFunction(s, names[i]));
}

export interface ArtifactIssue {
  path: string;
  message: string;
}

const GATEWAY_KEY_SHAPE = /cf_live_[A-Za-z0-9_-]{8,}/;

/**
 * Structural validation of a function-calling tools array against the
 * OpenAI function-calling contract (the RL-04 AC, without calling
 * OpenAI): every entry is a function tool with a spec-valid unique
 * name, a non-empty description, and object parameters. Also scans for
 * leaked credential material — generated artifacts must never carry a
 * gateway key.
 */
export function validateOpenAiTools(tools: unknown): ArtifactIssue[] {
  const issues: ArtifactIssue[] = [];
  if (!Array.isArray(tools)) return [{ path: 'tools', message: 'tools must be an array' }];
  const seen = new Set<string>();
  tools.forEach((t, i) => {
    const at = `tools[${i}]`;
    const tool = t as Record<string, any>;
    if (!tool || tool.type !== 'function') {
      issues.push({ path: at, message: 'tool type must be "function"' });
      return;
    }
    const fn = tool.function as Record<string, any> | undefined;
    if (!fn) {
      issues.push({ path: `${at}.function`, message: 'missing function object' });
      return;
    }
    if (typeof fn.name !== 'string' || !OPENAI_NAME_PATTERN.test(fn.name)) {
      issues.push({ path: `${at}.function.name`, message: `name must match ${OPENAI_NAME_PATTERN}` });
    } else if (seen.has(fn.name)) {
      issues.push({ path: `${at}.function.name`, message: `duplicate function name "${fn.name}"` });
    } else {
      seen.add(fn.name);
    }
    if (typeof fn.description !== 'string' || fn.description.trim() === '') {
      issues.push({ path: `${at}.function.description`, message: 'description must be a non-empty string' });
    }
    const params = fn.parameters as Record<string, unknown> | undefined;
    if (!params || typeof params !== 'object' || Array.isArray(params)) {
      issues.push({ path: `${at}.function.parameters`, message: 'parameters must be a JSON Schema object' });
    } else if (params.type !== 'object') {
      issues.push({ path: `${at}.function.parameters.type`, message: 'parameters.type must be "object"' });
    }
  });
  if (GATEWAY_KEY_SHAPE.test(JSON.stringify(tools))) {
    issues.push({ path: 'tools', message: 'artifact contains gateway-key material' });
  }
  return issues;
}

export interface GptActionsContext {
  connectorName: string;
  version: string;
  description: string;
  /** Execution base URL, e.g. https://api.example.com/v1/gpt-actions/p1/1.0.0 */
  serverUrl: string;
}

/** GPT Actions mark side-effecting operations so the model confirms
 *  first; read-only tools are non-consequential. */
export function isConsequential(snapshot: Record<string, any>): boolean {
  const classes = Array.isArray(snapshot?.effect_classes) ? snapshot.effect_classes : [];
  return Boolean(snapshot?.confirmation_required) || classes.some((c: unknown) => c !== 'read_only');
}

/**
 * Build the GPT Actions OpenAPI document for a release. One POST
 * operation per tool at `/{toolName}` under the per-release server URL;
 * the request body is the tool's argument object directly (the
 * execution surface unwraps nothing), and auth is the project's DP-07
 * gateway key sent as `X-API-Key` (Bearer is accepted too — declared in
 * the scheme description, since OpenAPI models one header per scheme).
 */
export function buildGptActionsOpenApi(
  ctx: GptActionsContext,
  snapshots: Array<Record<string, any>>,
): Record<string, unknown> {
  const names = dedupeNames(snapshots.map((s) => sanitizeOpenAiName(s?.name)));
  const paths: Record<string, unknown> = {};
  snapshots.forEach((s, i) => {
    const name = names[i];
    const parameters = toParametersSchema(s?.input_schema);
    const required = Array.isArray((parameters as any).required) ? (parameters as any).required : [];
    paths[`/${name}`] = {
      post: {
        operationId: name,
        summary: String(s?.description ?? name),
        description: agentDescription(s ?? {}),
        'x-openai-isConsequential': isConsequential(s),
        requestBody: {
          required: required.length > 0,
          content: { 'application/json': { schema: parameters } },
        },
        responses: {
          '200': {
            description: 'The upstream API result for this tool call.',
            content: {
              'application/json': {
                schema: { type: 'object', additionalProperties: true },
              },
            },
          },
          '401': { description: 'Missing, unknown, expired, or revoked gateway key.' },
          '403': { description: 'The owning workspace cannot write, or the tool needs a connected credential.' },
          '404': { description: 'Unknown project, release, or tool.' },
          '429': { description: 'Rate limited — retry after the delay named by the service.' },
          '502': { description: 'The upstream API failed or refused the call.' },
        },
        security: [{ GatewayKey: [] }],
      },
    };
  });
  return {
    openapi: '3.1.0',
    info: {
      title: ctx.connectorName,
      version: ctx.version,
      description: ctx.description,
    },
    servers: [{ url: ctx.serverUrl }],
    paths,
    components: {
      securitySchemes: {
        GatewayKey: {
          type: 'apiKey',
          in: 'header',
          name: 'X-API-Key',
          description:
            'A Connector Foundry gateway key for this project (Operate → Gateway keys). ' +
            'Authorization: Bearer <key> is also accepted.',
        },
      },
    },
    security: [{ GatewayKey: [] }],
  };
}

/** Collect every `$ref` in a JSON value that is not a local document ref. */
function externalRefs(value: unknown, at: string, out: ArtifactIssue[]): void {
  if (Array.isArray(value)) {
    value.forEach((v, i) => externalRefs(v, `${at}[${i}]`, out));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === '$ref' && typeof v === 'string' && !v.startsWith('#/')) {
        out.push({ path: at, message: `external $ref "${v}" cannot resolve inside this document` });
      } else {
        externalRefs(v, `${at}.${k}`, out);
      }
    }
  }
}

/**
 * Structural validation that a GPT Actions document imports cleanly
 * (the RL-04 AC, without the GPT editor): OpenAPI envelope, one server,
 * unique operationIds, every operation answering 200, the gateway-key
 * scheme declared and applied, no external `$ref`s, and no credential
 * material anywhere in the document.
 */
export function validateGptActionsOpenApi(doc: unknown): ArtifactIssue[] {
  const issues: ArtifactIssue[] = [];
  const d = doc as Record<string, any>;
  if (!d || typeof d !== 'object') return [{ path: 'document', message: 'document must be an object' }];
  if (d.openapi !== '3.1.0') issues.push({ path: 'openapi', message: 'openapi must be "3.1.0"' });
  if (!d.info?.title || !d.info?.version) {
    issues.push({ path: 'info', message: 'info.title and info.version are required' });
  }
  if (!Array.isArray(d.servers) || d.servers.length === 0 || !d.servers[0]?.url) {
    issues.push({ path: 'servers', message: 'at least one server with a url is required' });
  }
  const paths = (d.paths ?? {}) as Record<string, any>;
  const pathNames = Object.keys(paths);
  if (pathNames.length === 0) issues.push({ path: 'paths', message: 'at least one path is required' });
  const opIds = new Set<string>();
  for (const p of pathNames) {
    const op = paths[p]?.post;
    if (!op) {
      issues.push({ path: `paths.${p}`, message: 'each path must define a post operation' });
      continue;
    }
    if (typeof op.operationId !== 'string' || op.operationId === '') {
      issues.push({ path: `paths.${p}.post.operationId`, message: 'operationId is required' });
    } else if (opIds.has(op.operationId)) {
      issues.push({ path: `paths.${p}.post.operationId`, message: `duplicate operationId "${op.operationId}"` });
    } else {
      opIds.add(op.operationId);
    }
    if (!op.responses?.['200']) {
      issues.push({ path: `paths.${p}.post.responses`, message: 'a 200 response is required' });
    }
  }
  if (!d.components?.securitySchemes?.GatewayKey) {
    issues.push({ path: 'components.securitySchemes', message: 'the GatewayKey scheme must be declared' });
  }
  externalRefs(d, 'document', issues);
  if (GATEWAY_KEY_SHAPE.test(JSON.stringify(d))) {
    issues.push({ path: 'document', message: 'artifact contains gateway-key material' });
  }
  return issues;
}

export interface ReleaseSnapshots {
  releaseId: string;
  projectId: string;
  version: string;
  status: string;
  connectorName: string;
  description: string;
  snapshots: Array<Record<string, any>>;
}

/**
 * Load a release's frozen snapshots for artifact generation (RL-03's
 * resolveReleaseTools pattern, addressed by release id). Unknown
 * releases 404 exactly like the manifest endpoint; deprecated releases
 * refuse — their artifacts must not recruit new callers.
 */
export async function loadReleaseSnapshots(releaseId: string): Promise<ReleaseSnapshots> {
  const release = (await one(
    `SELECT id, project_id, version, status FROM releases WHERE id = $1`, [releaseId])) as any;
  if (!release) throw new HttpError(404, 'release_not_found', 'Release not found');
  if (release.status === 'deprecated') {
    throw new HttpError(409, 'release_deprecated',
      `Release ${release.version} is deprecated; its OpenAI artifacts are no longer served.`);
  }
  const project = (await one(`SELECT name FROM projects WHERE id = $1`, [release.project_id])) as any;
  const rows = (await q(
    `SELECT tool_snapshot FROM release_tools WHERE release_id = $1 ORDER BY tool_snapshot->>'name'`,
    [release.id])) as any[];
  const projectName = String(project?.name ?? release.project_id);
  return {
    releaseId: String(release.id),
    projectId: String(release.project_id),
    version: String(release.version),
    status: String(release.status),
    connectorName: `${projectName}-connector`,
    description: `Agent connector for ${projectName}, generated by Connector Foundry.`,
    snapshots: rows.map((r) => J.parse(r.tool_snapshot, {}) as Record<string, any>),
  };
}
