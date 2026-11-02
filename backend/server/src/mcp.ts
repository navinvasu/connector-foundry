// Hosted MCP server (RL-03): every approved release is also a Model
// Context Protocol server, served over Streamable HTTP. Claude (and any
// MCP client) connects to one URL per project, authenticates with a
// DP-07 gateway key, lists the release's frozen tools, and calls them —
// each call delegates to the data plane (runtime.invoke), so signature
// checks, credential injection (AB-02), egress policy (SE-08), rate
// limits (BE-07/SE-09), redaction (DP-05), and telemetry all apply
// exactly as they do to a direct invoke. No parallel execution path:
// "listed by MCP" and "served by invoke" are the same frozen snapshot.
//
// Protocol shape (JSON-RPC 2.0, MCP 2025-03-26 / 2024-11-05):
//   initialize → tools/list → tools/call, plus ping and empty
//   resources/prompts lists for clients that probe them. Tool-level
//   failures (unknown tool, upstream error, policy refusal) return as
//   `isError` tool results — never protocol errors — per the MCP spec;
//   protocol problems (bad method, bad params) are JSON-RPC errors.
// Notifications never get a response (route answers 202).

import { one, q, J } from './db.js';
import { invoke, type InvokeResult } from './runtime.js';
import { agentDescription, mcpAnnotations } from './tool-text.js';
import { declaredFromMeta, inferTrigger, type Attribution, type Trigger } from './attribution.js';
import { isChannelAlias, resolveChannelRelease } from './release.js';

export const MCP_PROTOCOL_VERSIONS = ['2025-03-26', '2024-11-05'] as const;
export const MCP_LATEST_PROTOCOL = MCP_PROTOCOL_VERSIONS[0];
export const MCP_SERVER_VERSION = '0.1.0';

/** Echo a supported client version; otherwise answer with our latest. */
export function negotiateProtocolVersion(requested: unknown): string {
  return typeof requested === 'string' && (MCP_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
    ? requested
    : MCP_LATEST_PROTOCOL;
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

/** Map one frozen tool snapshot to an MCP tool descriptor. */
export function toMcpTool(snapshot: Record<string, any>): McpTool {
  const raw = snapshot?.input_schema;
  const schema: Record<string, unknown> =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...(raw as Record<string, unknown>) } : {};
  if (schema.type === undefined) schema.type = 'object';
  if (schema.properties === undefined && schema.type === 'object') schema.properties = {};
  return {
    name: String(snapshot?.name ?? ''),
    description: agentDescription(snapshot ?? {}),
    inputSchema: schema,
    annotations: mcpAnnotations(snapshot ?? {}),
  };
}

export interface McpContext {
  projectId: string;
  /** Pinned version or channel alias (`staging`/`prod`) as requested. */
  version: string;
  actor?: string;
  clientIp?: string;
  /** D-89: the MCP session this request belongs to (Mcp-Session-Id), when known. */
  session?: { id: string; clientName: string | null; lastCallAt: Date | null };
  /** Fallback client label (the gateway key's label) when no session names one. */
  keyLabel?: string;
}

/** D-89: attribution for one tools/call — declared `_meta` wins, else session timing. */
export function mcpAttribution(ctx: McpContext, meta: unknown, now: Date = new Date()): Attribution {
  const declared = declaredFromMeta(meta);
  const inferred: Trigger = ctx.session ? inferTrigger(ctx.session.lastCallAt, now) : 'unknown';
  return {
    channel: 'mcp',
    client: ctx.session?.clientName ?? ctx.keyLabel ?? null,
    trigger: declared.trigger ?? inferred,
    trigger_source: declared.trigger ? 'declared' : 'inferred',
    session_id: ctx.session?.id ?? null,
    turn_id: declared.turn_id,
    prompt: declared.prompt,
  };
}

export interface ResolvedRelease {
  releaseId: string;
  version: string;
  projectName: string;
  tools: McpTool[];
}

/**
 * Resolve the release a tools/list should describe, mirroring the data
 * plane's serving rules (aliases → newest approved in channel; pinned
 * drafts serve, deprecated never does). Throws a plain Error whose
 * message is the customer-facing explanation.
 */
export async function resolveReleaseTools(ctx: Pick<McpContext, 'projectId' | 'version'>): Promise<ResolvedRelease> {
  let pinned = ctx.version;
  if (isChannelAlias(ctx.version)) {
    const resolved = await resolveChannelRelease(ctx.projectId, ctx.version);
    if (!resolved) {
      throw new Error(ctx.version === 'prod'
        ? 'No release has been promoted to prod for this project yet. Promote a staging release first, or connect with ?version=staging.'
        : 'No approved release is staged for this project yet. Create and approve a release first.');
    }
    pinned = resolved.version;
  }
  const release = (await one(
    `SELECT id, version, status FROM releases WHERE project_id = $1 AND version = $2`,
    [ctx.projectId, pinned])) as any;
  if (!release) throw new Error(`No release ${ctx.version} for this project.`);
  if (release.status === 'deprecated') {
    throw new Error(`Release ${pinned} was deprecated and is no longer served.`);
  }
  const project = (await one(`SELECT name FROM projects WHERE id = $1`, [ctx.projectId])) as any;
  const rows = (await q(
    `SELECT tool_snapshot FROM release_tools WHERE release_id = $1 ORDER BY tool_snapshot->>'name'`,
    [release.id])) as any[];
  return {
    releaseId: String(release.id),
    version: String(release.version),
    projectName: String(project?.name ?? ctx.projectId),
    tools: rows.map((r) => toMcpTool(J.parse(r.tool_snapshot, {}))),
  };
}

type JsonRpcId = string | number | null;

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string };
}

function rpcResult(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: JsonRpcId, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/** MCP tool result for one invoke: failures are results, not faults. */
export function invokeToToolResult(res: InvokeResult): { content: Array<{ type: 'text'; text: string }>; isError: boolean; structuredContent?: Record<string, unknown> } {
  if (res.ok) {
    const text = typeof res.result === 'string' ? res.result : JSON.stringify(res.result ?? null);
    const out: { content: Array<{ type: 'text'; text: string }>; isError: boolean; structuredContent?: Record<string, unknown> } = {
      content: [{ type: 'text', text }],
      isError: false,
    };
    if (res.result && typeof res.result === 'object' && !Array.isArray(res.result)) {
      out.structuredContent = res.result as Record<string, unknown>;
    }
    return out;
  }
  const condition = res.error?.condition ?? 'INVOKE_FAILED';
  const message = res.error?.message ?? 'The tool call failed.';
  return { content: [{ type: 'text', text: `${condition}: ${message}` }], isError: true };
}

/**
 * Handle one JSON-RPC message. Returns the response object, or null for
 * notifications (which must never be answered). `runInvoke` is injectable
 * for tests; production passes the data plane's invoke.
 */
export async function handleMcpMessage(
  msg: unknown,
  ctx: McpContext,
  runInvoke: typeof invoke = invoke,
): Promise<JsonRpcResponse | null> {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
    return rpcError(null, -32600, 'Invalid request: expected a JSON-RPC object.');
  }
  const m = msg as Record<string, any>;
  const hasId = 'id' in m && m.id !== undefined;
  const id: JsonRpcId = hasId ? (m.id as JsonRpcId) : null;
  const method = typeof m.method === 'string' ? m.method : null;
  if (!method) {
    return hasId ? rpcError(id, -32600, 'Invalid request: missing method.') : null;
  }
  // Notifications (no id): acknowledge silently, whatever the method.
  if (!hasId) return null;

  switch (method) {
    case 'initialize': {
      const params = (m.params ?? {}) as Record<string, any>;
      let projectName = ctx.projectId;
      try {
        const resolved = await resolveReleaseTools(ctx);
        projectName = resolved.projectName;
      } catch { /* server info still answers; tools/list reports the gap */ }
      return rpcResult(id, {
        protocolVersion: negotiateProtocolVersion(params.protocolVersion),
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: `connector-foundry/${projectName}`, version: MCP_SERVER_VERSION },
        instructions:
          `Connector Foundry MCP server for ${projectName} (release selection: ${ctx.version}). ` +
          'Tools are the frozen, evaluated tools of that release; calls run through the Foundry data plane. ' +
          'Safety rules: look identifiers up with a read tool instead of guessing them; ' +
          'ask the user to confirm before calling any tool whose destructiveHint is true; ' +
          'if a call fails, report the error rather than retrying a write.',
      });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list': {
      try {
        const resolved = await resolveReleaseTools(ctx);
        return rpcResult(id, { tools: resolved.tools });
      } catch (e) {
        return rpcError(id, -32000, e instanceof Error ? e.message : 'Could not list tools for this release.');
      }
    }
    case 'tools/call': {
      const params = (m.params ?? {}) as Record<string, any>;
      const name = typeof params.name === 'string' ? params.name : null;
      if (!name) return rpcError(id, -32602, 'Invalid params: tools/call requires a tool "name".');
      const args = params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
        ? (params.arguments as Record<string, unknown>)
        : {};
      const res = await runInvoke({
        project_id: ctx.projectId,
        version: ctx.version,
        tool_name: name,
        args,
        client_ip: ctx.clientIp,
        actor: ctx.actor,
        attribution: mcpAttribution(ctx, params._meta),
      });
      if (ctx.session) ctx.session.lastCallAt = new Date();
      return rpcResult(id, invokeToToolResult(res));
    }
    case 'resources/list':
      return rpcResult(id, { resources: [] });
    case 'resources/templates/list':
      return rpcResult(id, { resourceTemplates: [] });
    case 'prompts/list':
      return rpcResult(id, { prompts: [] });
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

/**
 * Handle a request body that may be a single message or a batch (the
 * 2024-11-05 dialect allows batches). Returns the single response, an
 * array of responses, or null when everything was a notification.
 */
export async function handleMcpBody(
  body: unknown,
  ctx: McpContext,
  runInvoke: typeof invoke = invoke,
): Promise<JsonRpcResponse | JsonRpcResponse[] | null> {
  if (Array.isArray(body)) {
    const out: JsonRpcResponse[] = [];
    for (const item of body) {
      const r = await handleMcpMessage(item, ctx, runInvoke);
      if (r) out.push(r);
    }
    return out.length > 0 ? out : null;
  }
  return handleMcpMessage(body, ctx, runInvoke);
}

/**
 * RL-03 build-time artifact: a dependency-free Node stdio bridge for
 * enterprise users who run MCP over stdio. It forwards newline-delimited
 * JSON-RPC between the local MCP client and the hosted server verbatim;
 * the gateway key comes from the environment at runtime and is never
 * written into the generated file.
 */
export function renderStdioBridgeScript(opts: { mcpUrl: string; projectId: string; version: string }): string {
  return `#!/usr/bin/env node
// Connector Foundry MCP stdio bridge — generated for project ${opts.projectId}, release ${opts.version}.
// Forwards stdio JSON-RPC to the hosted MCP server. Requires Node 18+.
//   CF_GATEWAY_KEY=<your-gateway-key> node ${'connector-foundry-mcp.mjs'}
// The key is read from the environment and never stored in this file.
import { createInterface } from 'node:readline';

const url = process.env.CF_MCP_URL ?? ${JSON.stringify(opts.mcpUrl)};
const key = process.env.CF_GATEWAY_KEY ?? '';
if (!key) {
  console.error('CF_GATEWAY_KEY is not set — mint a gateway key in Operate and export it first.');
  process.exit(1);
}

const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try { msg = JSON.parse(trimmed); } catch {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\\n');
    return;
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
    body: JSON.stringify(msg),
  });
  if (res.status === 202) return; // notification: nothing to answer
  const text = await res.text();
  if (text) process.stdout.write(text + '\\n');
});
`;
}
