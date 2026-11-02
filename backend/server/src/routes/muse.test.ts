// HK-08 HTTP layer: Muse submission kit download (tenant-scoped read).
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
  requireProjectRead: () => (_req: any, _res: any, next: any) => next(),
}));

import { one, q } from '../db.js';
import { releasesRouter } from './workflow.js';
import { errorHandler } from '../errors.js';

const oneMock = vi.mocked(one);
const qMock = vi.mocked(q);

const readTool = {
  name: 'getPrice', description: 'Get the price',
  effect_classes: ['read_only'], confirmation_required: false,
  credential_mode: 'none', required_scopes: [],
};

function app() {
  const a = express();
  a.use(express.json());
  a.use((req: any, _res, next) => { req.id = 'test-req'; next(); });
  a.use('/v1/releases', releasesRouter);
  a.use(errorHandler);
  return a;
}

beforeEach(() => {
  vi.clearAllMocks();
  oneMock.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM releases')) return { id: 'r1', project_id: 'p1', version: '1.0.0', status: 'approved' };
    if (sql.includes('FROM projects')) return { name: 'Acme' };
    return undefined;
  });
  qMock.mockResolvedValue([{ tool_snapshot: readTool }]);
});

describe('GET /v1/releases/:releaseId/muse/kit', () => {
  it('serves the submission kit with the hosted MCP endpoint and a passing gate', async () => {
    const res = await request(app()).get('/v1/releases/r1/muse/kit');
    expect(res.status).toBe(200);
    expect(res.body.connector).toMatchObject({ name: 'Acme-connector', version: '1.0.0' });
    expect(res.body.connection.type).toBe('existing_mcp');
    expect(res.body.connection.mcp_endpoint).toContain('/v1/mcp/p1');
    expect(res.body.tools).toEqual([{ name: 'getPrice', description: 'Get the price', access_class: 'read', confirmation: 'never', effects: ['read_only'] }]);
    expect(res.body.review_gate).toEqual({ eligible: true, reasons: [] });
    expect(res.headers['content-disposition']).toContain('muse-connector-kit-1.0.0.json');
  });

  it('blocks the gate for a money-movement tool with a reason', async () => {
    qMock.mockResolvedValue([{ tool_snapshot: { ...readTool, name: 'createTransfer', description: 'Transfer funds' } }]);
    const res = await request(app()).get('/v1/releases/r1/muse/kit');
    expect(res.status).toBe(200);
    expect(res.body.review_gate.eligible).toBe(false);
    expect(res.body.review_gate.reasons).toMatchObject([{ tool: 'createTransfer', reason: 'money_movement' }]);
  });

  it('404s an unknown release', async () => {
    oneMock.mockResolvedValue(undefined);
    const res = await request(app()).get('/v1/releases/nope/muse/kit');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('release_not_found');
  });
});
