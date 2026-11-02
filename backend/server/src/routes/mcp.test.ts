// RL-03 HTTP layer: POST /v1/mcp/:projectId — gateway-key auth (401 /
// cross-project 404 / non-writable 403, DP-07 parity), JSON-RPC over the
// wire, notifications → 202, GET → 405, malformed JSON → -32700.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../db.js', () => ({
  one: vi.fn(),
  q: vi.fn(),
  exec: vi.fn(),
  uid: () => 'sess-1',
  J: { parse: (v: any, fb: any) => (v == null ? fb : typeof v === 'string' ? JSON.parse(v) : v) },
}));
vi.mock('../runtime.js', () => ({ invoke: vi.fn() }));
vi.mock('../release.js', () => ({
  isChannelAlias: (v: string) => v === 'staging' || v === 'prod',
  resolveChannelRelease: vi.fn(),
}));

import { one, q, exec } from '../db.js';
import { invoke } from '../runtime.js';
import { resolveChannelRelease } from '../release.js';
import { mcpRouter } from './mcp.js';
import { generateGatewayKeySecret, gatewayKeyPrefix, hashGatewayKey } from '../gateway-keys.js';

const oneMock = vi.mocked(one);
const qMock = vi.mocked(q);
const execMock = vi.mocked(exec);
const invokeMock = vi.mocked(invoke);
const resolveMock = vi.mocked(resolveChannelRelease);

const SECRET = generateGatewayKeySecret();

function keyRow(over: any = {}) {
  return {
    id: 'k1', project_id: 'p1', label: 'claude', key_prefix: gatewayKeyPrefix(SECRET),
    key_hash: hashGatewayKey(SECRET), status: 'active', expires_at: null,
    customer_status: 'active', ...over,
  };
}

function app() {
  const a = express();
  a.use((req: any, _res, next) => { req.id = 'test-req'; next(); });
  a.use('/v1/mcp', mcpRouter);
  a.use((err: any, _req: any, res: any, _next: any) => {
    res.status(err?.status ?? 500).json({ error: err?.message ?? 'error' });
  });
  return a;
}

beforeEach(() => {
  vi.clearAllMocks();
  execMock.mockResolvedValue(1);
  resolveMock.mockResolvedValue({ id: 'r1', version: '1.0.0' });
  oneMock.mockImplementation(async (sql: string) => {
    if (sql.includes('project_api_keys')) return keyRow();
    if (sql.includes('FROM releases')) return { id: 'r1', version: '1.0.0', status: 'approved' };
    if (sql.includes('FROM projects')) return { name: 'Weather API' };
    return undefined;
  });
  qMock.mockResolvedValue([{
    tool_snapshot: {
      name: 'getForecast', description: 'Forecast',
      input_schema: { type: 'object', properties: { city: { type: 'string' } } },
    },
  }]);
  invokeMock.mockResolvedValue({
    ok: true, tool: 'getForecast', release_version: '1.0.0', result: { temp: 21 }, latency_ms: 2,
  });
});

const rpc = (body: any) => request(app()).post('/v1/mcp/p1').set('Authorization', `Bearer ${SECRET}`).send(body);

describe('MCP endpoint auth', () => {
  it('401s without a key and for an unknown key, without invoking', async () => {
    const noKey = await request(app()).post('/v1/mcp/p1').send({ jsonrpc: '2.0', id: 1, method: 'ping' });
    expect(noKey.status).toBe(401);
    expect(noKey.body.code).toBe('invalid_api_key');

    oneMock.mockImplementation(async (sql: string) => (sql.includes('project_api_keys') ? undefined : { name: 'x' }));
    const bad = await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' });
    expect(bad.status).toBe(401);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('404s when the key belongs to another project', async () => {
    const res = await request(app()).post('/v1/mcp/p-other')
      .set('Authorization', `Bearer ${SECRET}`).send({ jsonrpc: '2.0', id: 1, method: 'ping' });
    expect(res.status).toBe(404);
  });

  it('403s when the owning customer cannot write', async () => {
    oneMock.mockImplementation(async (sql: string) => {
      if (sql.includes('project_api_keys')) return keyRow({ customer_status: 'suspended' });
      return undefined;
    });
    const res = await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' });
    expect(res.status).toBe(403);
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

describe('MCP endpoint protocol', () => {
  it('completes the initialize → tools/list → tools/call flow', async () => {
    const init = await rpc({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-03-26', clientInfo: { name: 'claude-ai', version: '1.0' } },
    });
    expect(init.status).toBe(200);
    expect(init.body.result.serverInfo.name).toBe('connector-foundry/Weather API');
    // D-89: initialize opens a session that records the client's name.
    expect(init.headers['mcp-session-id']).toBe('sess-1');
    expect(execMock).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO mcp_sessions'),
      ['sess-1', 'p1', 'claude-ai', '1.0', `api-key:${gatewayKeyPrefix(SECRET)}`]);

    const list = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(list.body.result.tools).toHaveLength(1);
    expect(list.body.result.tools[0].name).toBe('getForecast');
    expect(list.body.result.tools[0].inputSchema.type).toBe('object');

    const call = await rpc({
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'getForecast', arguments: { city: 'Lathrop' } },
    });
    expect(call.body.result.isError).toBe(false);
    expect(call.body.result.content[0].text).toContain('"temp":21');
    // Default version selection is the prod alias; the key actor is recorded.
    expect(invokeMock).toHaveBeenCalledWith(expect.objectContaining({
      project_id: 'p1', version: 'prod', actor: `api-key:${gatewayKeyPrefix(SECRET)}`,
    }));
    expect(JSON.stringify(invokeMock.mock.calls)).not.toContain(SECRET);
  });

  it('honors ?version= selection over the prod default', async () => {
    await request(app()).post('/v1/mcp/p1?version=staging')
      .set('Authorization', `Bearer ${SECRET}`)
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'getForecast', arguments: {} } });
    expect(invokeMock).toHaveBeenCalledWith(expect.objectContaining({ version: 'staging' }));
  });

  it('answers notifications with 202 and no body', async () => {
    const res = await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(res.status).toBe(202);
    expect(res.text).toBe('');
  });

  it('rejects GET with 405 (no SSE stream) and malformed JSON with -32700', async () => {
    const get = await request(app()).get('/v1/mcp/p1').set('Authorization', `Bearer ${SECRET}`);
    expect(get.status).toBe(405);
    expect(get.headers.allow).toContain('POST');

    const bad = await request(app()).post('/v1/mcp/p1')
      .set('Authorization', `Bearer ${SECRET}`)
      .set('Content-Type', 'application/json')
      .send('{"jsonrpc": broken');
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe(-32700);
  });
});
