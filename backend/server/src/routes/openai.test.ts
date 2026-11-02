// RL-04 HTTP layer: release artifact downloads (tenant-scoped reads)
// and the GPT Actions execution surface (gateway-key auth, DP-07 parity,
// invoke delegation with honest failure statuses).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../db.js', () => ({
  one: vi.fn(),
  q: vi.fn(),
  exec: vi.fn(),
  J: { parse: (v: any, fb: any) => (v == null ? fb : typeof v === 'string' ? JSON.parse(v) : v) },
}));
vi.mock('../runtime.js', () => ({ invoke: vi.fn(), telemetrySummary: vi.fn() }));
vi.mock('../eval.js', () => ({ getRun: vi.fn() }));
vi.mock('../auth.js', () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
  requireProjectRole: () => (_req: any, _res: any, next: any) => next(),
  // Scoping itself is covered with the real middleware in tenancy.test.ts.
  requireProjectRead: () => (_req: any, _res: any, next: any) => next(),
}));

import { one, q, exec } from '../db.js';
import { invoke } from '../runtime.js';
import { releasesRouter } from './workflow.js';
import { gptActionsRouter, statusForInvokeFailure } from './gpt-actions.js';
import { errorHandler } from '../errors.js';
import { generateGatewayKeySecret, gatewayKeyPrefix, hashGatewayKey } from '../gateway-keys.js';

const oneMock = vi.mocked(one);
const qMock = vi.mocked(q);
const execMock = vi.mocked(exec);
const invokeMock = vi.mocked(invoke);

const SECRET = generateGatewayKeySecret();

const forecast = {
  name: 'getForecast', description: 'Get the forecast for a city',
  input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  effect_classes: ['read_only'], confirmation_required: false,
};

function keyRow(over: any = {}) {
  return {
    id: 'k1', project_id: 'p1', label: 'gpt', key_prefix: gatewayKeyPrefix(SECRET),
    key_hash: hashGatewayKey(SECRET), status: 'active', expires_at: null,
    customer_status: 'active', ...over,
  };
}

function app() {
  const a = express();
  a.use(express.json());
  a.use((req: any, _res, next) => { req.id = 'test-req'; req.auth = { userId: 'u1', memberships: [] }; next(); });
  a.use('/v1/releases', releasesRouter);
  a.use('/v1/gpt-actions', gptActionsRouter);
  a.use(errorHandler);
  return a;
}

beforeEach(() => {
  vi.clearAllMocks();
  execMock.mockResolvedValue(1);
  oneMock.mockImplementation(async (sql: string) => {
    if (sql.includes('project_api_keys')) return keyRow();
    if (sql.includes('FROM releases')) return { id: 'r1', project_id: 'p1', version: '1.0.0', status: 'approved' };
    if (sql.includes('FROM projects')) return { name: 'Weather' };
    return undefined;
  });
  qMock.mockResolvedValue([{ tool_snapshot: forecast }]);
  invokeMock.mockResolvedValue({
    ok: true, tool: 'getForecast', release_version: '1.0.0', result: { temp: 21 }, latency_ms: 2,
  });
});

describe('GET /v1/releases/:releaseId/openai/tools', () => {
  it('serves the function-calling tools array for the release', async () => {
    const res = await request(app()).get('/v1/releases/r1/openai/tools');
    expect(res.status).toBe(200);
    expect(res.body.release_id).toBe('r1');
    expect(res.body.tools).toEqual([{
      type: 'function',
      function: {
        name: 'getForecast', description: 'Get the forecast for a city',
        parameters: forecast.input_schema, strict: false,
      },
    }]);
  });

  it('404s an unknown release', async () => {
    oneMock.mockImplementation(async (sql: string) => {
      if (sql.includes('project_api_keys')) return keyRow();
      return undefined;
    });
    const res = await request(app()).get('/v1/releases/nope/openai/tools');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('release_not_found');
  });
});

describe('GET /v1/releases/:releaseId/openai/actions', () => {
  it('serves a GPT Actions document pointed at this origin', async () => {
    const res = await request(app()).get('/v1/releases/r1/openai/actions');
    expect(res.status).toBe(200);
    expect(res.body.openapi).toBe('3.1.0');
    expect(res.body.info.title).toBe('Weather-connector');
    expect(res.body.servers[0].url).toContain('/v1/gpt-actions/p1/1.0.0');
    expect(res.body.paths['/getForecast'].post.operationId).toBe('getForecast');
    expect(JSON.stringify(res.body)).not.toContain(SECRET);
  });
});

describe('POST /v1/gpt-actions/:projectId/:version/:toolName', () => {
  const call = () => request(app())
    .post('/v1/gpt-actions/p1/1.0.0/getForecast')
    .set('Authorization', `Bearer ${SECRET}`)
    .send({ city: 'Lathrop' });

  it('401s without a key and for an unknown key, without invoking', async () => {
    const noKey = await request(app()).post('/v1/gpt-actions/p1/1.0.0/getForecast').send({});
    expect(noKey.status).toBe(401);
    expect(noKey.body.code).toBe('invalid_api_key');

    oneMock.mockImplementation(async (sql: string) => (sql.includes('project_api_keys') ? undefined : { name: 'x' }));
    const bad = await call();
    expect(bad.status).toBe(401);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('404s when the key belongs to another project', async () => {
    const res = await request(app()).post('/v1/gpt-actions/p-other/1.0.0/getForecast')
      .set('Authorization', `Bearer ${SECRET}`).send({});
    expect(res.status).toBe(404);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('403s when the owning customer cannot write', async () => {
    oneMock.mockImplementation(async (sql: string) =>
      sql.includes('project_api_keys') ? keyRow({ customer_status: 'suspended' }) : undefined);
    const res = await call();
    expect(res.status).toBe(403);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('delegates to invoke with the body as args and returns the bare result', async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ temp: 21 });
    expect(invokeMock).toHaveBeenCalledWith(expect.objectContaining({
      project_id: 'p1', version: '1.0.0', tool_name: 'getForecast',
      args: { city: 'Lathrop' }, actor: `api-key:${gatewayKeyPrefix(SECRET)}`,
    }));
    expect(JSON.stringify(invokeMock.mock.calls)).not.toContain(SECRET);
  });

  it('maps invoke failures to honest statuses', async () => {
    invokeMock.mockResolvedValue({
      ok: false, tool: 'getForecast', release_version: '1.0.0', latency_ms: 1,
      error: { condition: 'UNKNOWN_TOOL', message: 'no such tool' },
    });
    const res = await call();
    expect(res.status).toBe(404);
    expect(res.body.error.condition).toBe('UNKNOWN_TOOL');
  });

  it('statusForInvokeFailure covers the mapping table', () => {
    const fail = (condition: string) => ({ ok: false, tool: 't', release_version: '1', latency_ms: 0, error: { condition, message: 'x' } });
    expect(statusForInvokeFailure(fail('RATE_LIMITED'))).toBe(429);
    expect(statusForInvokeFailure(fail('RELEASE_CHANNEL_EMPTY'))).toBe(404);
    expect(statusForInvokeFailure(fail('CREDENTIAL_REQUIRED'))).toBe(403);
    expect(statusForInvokeFailure(fail('EGRESS_BLOCKED'))).toBe(403);
    expect(statusForInvokeFailure(fail('UPSTREAM_TIMEOUT'))).toBe(502);
  });
});
