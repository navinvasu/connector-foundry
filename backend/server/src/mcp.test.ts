// RL-03: MCP protocol core — handshake negotiation, tools/list from the
// frozen release snapshot, tools/call delegating to the data plane, and
// MCP-conformant error shapes (tool failures are isError results,
// protocol failures are JSON-RPC errors). DB + invoke are mocked.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./db.js', () => ({
  one: vi.fn(),
  q: vi.fn(),
  exec: vi.fn(),
  J: { parse: (v: any, fb: any) => (v == null ? fb : typeof v === 'string' ? JSON.parse(v) : v) },
}));
vi.mock('./runtime.js', () => ({ invoke: vi.fn() }));
vi.mock('./release.js', () => ({
  isChannelAlias: (v: string) => v === 'staging' || v === 'prod',
  resolveChannelRelease: vi.fn(),
}));

import { one, q } from './db.js';
import { resolveChannelRelease } from './release.js';
import {
  negotiateProtocolVersion, toMcpTool, invokeToToolResult,
  handleMcpMessage, handleMcpBody, renderStdioBridgeScript, mcpAttribution,
} from './mcp.js';

const oneMock = vi.mocked(one);
const qMock = vi.mocked(q);
const resolveMock = vi.mocked(resolveChannelRelease);

const CTX = { projectId: 'p1', version: '1.0.0', actor: 'api-key:cf_live_abcd1234', clientIp: '203.0.113.9' };

const snapshot = (name: string, over: any = {}) => ({
  name, description: `${name} description`,
  input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  ...over,
});

function mockRelease(status = 'approved', tools = [snapshot('getForecast')]) {
  oneMock.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM releases')) return { id: 'r1', version: '1.0.0', status };
    if (sql.includes('FROM projects')) return { name: 'Weather API' };
    return undefined;
  });
  qMock.mockResolvedValue(tools.map((t) => ({ tool_snapshot: t })));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRelease();
  resolveMock.mockResolvedValue({ id: 'r1', version: '1.0.0' });
});

describe('negotiateProtocolVersion', () => {
  it('echoes supported client versions and falls back to latest otherwise', () => {
    expect(negotiateProtocolVersion('2024-11-05')).toBe('2024-11-05');
    expect(negotiateProtocolVersion('2025-03-26')).toBe('2025-03-26');
    expect(negotiateProtocolVersion('1999-01-01')).toBe('2025-03-26');
    expect(negotiateProtocolVersion(undefined)).toBe('2025-03-26');
  });
});

describe('toMcpTool', () => {
  it('maps a snapshot and guarantees an object inputSchema', () => {
    expect(toMcpTool(snapshot('getForecast'))).toEqual({
      name: 'getForecast', description: 'getForecast description',
      inputSchema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
      annotations: {
        title: 'Get forecast', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true,
      },
    });
    expect(toMcpTool({ name: 'bare', description: 'd' }).inputSchema).toEqual({ type: 'object', properties: {} });
  });

  it('tells the agent when to use the tool and marks read-only / destructive access', () => {
    const read = toMcpTool({
      name: 'listOrders', description: 'Lists orders.', eligible_use: 'the user asks for their orders',
      ineligible_use: 'the user wants to cancel an order', effect_classes: ['read_only'],
    });
    expect(read.description).toBe('Lists orders.\nUse when: the user asks for their orders\nDo not use when: the user wants to cancel an order');
    expect(read.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true });
    const del = toMcpTool({ name: 'deleteOrder', description: 'x', effect_classes: ['destructive'] });
    expect(del.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  });
});

describe('invokeToToolResult', () => {
  it('wraps success as content (+ structuredContent for objects) and failure as isError', () => {
    const ok = invokeToToolResult({ ok: true, tool: 't', release_version: '1.0.0', result: { temp: 21 }, latency_ms: 3 });
    expect(ok.isError).toBe(false);
    expect(ok.content[0].text).toContain('"temp":21');
    expect(ok.structuredContent).toEqual({ temp: 21 });

    const bad = invokeToToolResult({
      ok: false, tool: 't', release_version: '1.0.0', latency_ms: 3,
      error: { condition: 'CREDENTIAL_REQUIRED', message: 'Connect an account first.' },
    });
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).toBe('CREDENTIAL_REQUIRED: Connect an account first.');
  });
});

describe('handleMcpMessage', () => {
  it('initialize negotiates the version and names the server after the project', async () => {
    const res = await handleMcpMessage(
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } }, CTX, vi.fn());
    expect(res?.error).toBeUndefined();
    const result = res?.result as any;
    expect(result.protocolVersion).toBe('2024-11-05');
    expect(result.serverInfo.name).toBe('connector-foundry/Weather API');
    expect(result.capabilities).toEqual({ tools: { listChanged: false } });
  });

  it('tools/list serves exactly the frozen snapshot tools', async () => {
    mockRelease('approved', [snapshot('getForecast'), snapshot('getCities', { input_schema: undefined })]);
    const res = await handleMcpMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, CTX, vi.fn());
    const tools = (res?.result as any).tools;
    expect(tools.map((t: any) => t.name)).toEqual(['getForecast', 'getCities']);
    expect(tools[1].inputSchema).toEqual({ type: 'object', properties: {} });
  });

  it('tools/list on an empty prod channel explains how to fix it', async () => {
    resolveMock.mockResolvedValue(null);
    const res = await handleMcpMessage(
      { jsonrpc: '2.0', id: 3, method: 'tools/list' }, { ...CTX, version: 'prod' }, vi.fn());
    expect(res?.error?.code).toBe(-32000);
    expect(res?.error?.message).toContain('Promote a staging release');
  });

  it('tools/list refuses a deprecated release', async () => {
    mockRelease('deprecated');
    const res = await handleMcpMessage({ jsonrpc: '2.0', id: 4, method: 'tools/list' }, CTX, vi.fn());
    expect(res?.error?.code).toBe(-32000);
    expect(res?.error?.message).toContain('deprecated');
  });

  it('tools/call delegates to invoke with the key actor and caller IP', async () => {
    const runInvoke = vi.fn().mockResolvedValue({
      ok: true, tool: 'getForecast', release_version: '1.0.0', result: { temp: 21 }, latency_ms: 5,
    });
    const res = await handleMcpMessage(
      { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'getForecast', arguments: { city: 'Lathrop' } } },
      CTX, runInvoke);
    expect(runInvoke).toHaveBeenCalledWith({
      project_id: 'p1', version: '1.0.0', tool_name: 'getForecast',
      args: { city: 'Lathrop' }, client_ip: '203.0.113.9', actor: 'api-key:cf_live_abcd1234',
      attribution: {
        channel: 'mcp', client: null, trigger: 'unknown', trigger_source: 'inferred',
        session_id: null, turn_id: null, prompt: null,
      },
    });
    expect((res?.result as any).isError).toBe(false);
  });

  it('D-89: attributes calls to the session client, inferring user turns from timing', () => {
    const t0 = new Date('2026-10-24T10:00:00Z');
    const ctx = { ...CTX, session: { id: 's1', clientName: 'claude-ai', lastCallAt: null as Date | null } };
    expect(mcpAttribution(ctx, undefined, t0)).toMatchObject({ client: 'claude-ai', trigger: 'user_prompt', trigger_source: 'inferred', session_id: 's1' });
    ctx.session.lastCallAt = t0;
    expect(mcpAttribution(ctx, undefined, new Date(t0.getTime() + 3_000)).trigger).toBe('agent_followup');
    expect(mcpAttribution(ctx, undefined, new Date(t0.getTime() + 60_000)).trigger).toBe('user_prompt');
  });

  it('D-89: declared _meta wins over inference and carries the prompt', () => {
    const a = mcpAttribution({ ...CTX, keyLabel: 'nightly sync' }, {
      'connectorfoundry.com/trigger': 'automated',
      'connectorfoundry.com/turn_id': 'turn-9',
      'connectorfoundry.com/prompt': 'Which orders shipped today?',
    });
    expect(a).toEqual({
      channel: 'mcp', client: 'nightly sync', trigger: 'automated', trigger_source: 'declared',
      session_id: null, turn_id: 'turn-9', prompt: 'Which orders shipped today?',
    });
    expect(mcpAttribution(CTX, { 'connectorfoundry.com/trigger': 'bogus' }).trigger_source).toBe('inferred');
  });

  it('tools/call surfaces invoke failures as isError results, not protocol errors', async () => {
    const runInvoke = vi.fn().mockResolvedValue({
      ok: false, tool: 'nope', release_version: '1.0.0', latency_ms: 1,
      error: { condition: 'UNKNOWN_TOOL', message: 'Tool "nope" is not in release 1.0.0.' },
    });
    const res = await handleMcpMessage(
      { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'nope' } }, CTX, runInvoke);
    expect(res?.error).toBeUndefined();
    expect((res?.result as any).isError).toBe(true);
    expect((res?.result as any).content[0].text).toContain('UNKNOWN_TOOL');
  });

  it('protocol problems map to JSON-RPC errors; notifications stay silent', async () => {
    expect((await handleMcpMessage({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: {} }, CTX, vi.fn()))?.error?.code).toBe(-32602);
    expect((await handleMcpMessage({ jsonrpc: '2.0', id: 8, method: 'bogus/method' }, CTX, vi.fn()))?.error?.code).toBe(-32601);
    expect((await handleMcpMessage('not an object', CTX, vi.fn()))?.error?.code).toBe(-32600);
    expect(await handleMcpMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, CTX, vi.fn())).toBeNull();
    expect(await handleMcpMessage({ jsonrpc: '2.0', method: 'bogus/notification' }, CTX, vi.fn())).toBeNull();
    const ping = await handleMcpMessage({ jsonrpc: '2.0', id: 9, method: 'ping' }, CTX, vi.fn());
    expect(ping?.result).toEqual({});
    const resources = await handleMcpMessage({ jsonrpc: '2.0', id: 10, method: 'resources/list' }, CTX, vi.fn());
    expect(resources?.result).toEqual({ resources: [] });
  });

  it('batches answer each request and drop notifications', async () => {
    const out = await handleMcpBody([
      { jsonrpc: '2.0', id: 1, method: 'ping' },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'ping' },
    ], CTX, vi.fn());
    expect(Array.isArray(out)).toBe(true);
    expect((out as any[]).map((r) => r.id)).toEqual([1, 2]);
    expect(await handleMcpBody([{ jsonrpc: '2.0', method: 'notifications/initialized' }], CTX, vi.fn())).toBeNull();
  });
});

describe('renderStdioBridgeScript', () => {
  it('embeds the hosted URL but never a key — the key comes from the environment', () => {
    const script = renderStdioBridgeScript({
      mcpUrl: 'https://api.example.com/v1/mcp/p1?version=1.0.0', projectId: 'p1', version: '1.0.0',
    });
    expect(script).toContain('https://api.example.com/v1/mcp/p1?version=1.0.0');
    expect(script).toContain('CF_GATEWAY_KEY');
    expect(script).not.toContain('cf_live_');
    expect(script).toContain('fetch(url');
  });
});
