// Passed-only flow: POST /v1/projects/:id/eval/runs/:runId/keep-passed
// demotes the run's failed (still-approved) tools to candidate so they leave
// the release set; passed tools are untouched.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../db.js', () => ({
  q: vi.fn(), exec: vi.fn(), audit: vi.fn(),
  J: { parse: (v: any, fb: any) => (v == null ? fb : typeof v === 'string' ? JSON.parse(v) : v) },
}));
vi.mock('../eval.js', () => ({ getRun: vi.fn(), summarizeToolOutcomes: vi.fn() }));
vi.mock('../release.js', () => ({
  createRelease: vi.fn(), approveRelease: vi.fn(), getManifest: vi.fn(),
  rollbackRelease: vi.fn(), promoteRelease: vi.fn(), promotionReadiness: vi.fn(),
}));
vi.mock('../runtime.js', () => ({ invoke: vi.fn(), telemetrySummary: vi.fn() }));
vi.mock('../auth.js', () => ({
  requireProjectRole: () => (_req: any, _res: any, next: any) => next(),
  requireProjectRead: () => (_req: any, _res: any, next: any) => next(),
}));

import { q, exec } from '../db.js';
import { getRun, summarizeToolOutcomes } from '../eval.js';
import { errorHandler } from '../errors.js';
import { evalRouter } from './workflow.js';

const qMock = vi.mocked(q);
const execMock = vi.mocked(exec);
const getRunMock = vi.mocked(getRun);
const summarizeMock = vi.mocked(summarizeToolOutcomes);

function app() {
  const a = express();
  a.use(express.json());
  a.use((req: any, _res, next) => { req.auth = { userId: 'u1', memberships: [] }; next(); });
  a.use('/v1/projects', evalRouter);
  a.use(errorHandler);
  return a;
}

const TOOLS = [
  { id: 't1', name: 'GetQuote', status: 'tested' },
  { id: 't2', name: 'GetBonds', status: 'approved' },
  { id: 't3', name: 'GetStocks', status: 'approved' },
];
const OUTCOMES = {
  total: 3, passed: 1, failed: 2, passed_tool_ids: ['t1'],
  failed_tools: [
    { tool_id: 't2', tool_name: 'GetBonds', failed_scenarios: 2, categories: ['access_not_allowed'] },
    { tool_id: 't3', tool_name: 'GetStocks', failed_scenarios: 1, categories: ['api_key_rejected'] },
  ],
  failures_by_category: [
    { category: 'api_key_rejected', label: 'API key rejected (401)', tool_count: 1, suggestion: 'Check the key.' },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  execMock.mockResolvedValue(2 as any);
  summarizeMock.mockReturnValue(OUTCOMES as any);
  qMock.mockResolvedValue(TOOLS as any);
  getRunMock.mockResolvedValue({
    run: { id: 'run-1', project_id: 'p1', status: 'failed', summary: JSON.stringify({ suites: {} }) },
    results: [],
  } as any);
});

describe('POST keep-passed', () => {
  it('excludes failed approved tools and reports kept/excluded by name', async () => {
    const res = await request(app()).post('/v1/projects/p1/eval/runs/run-1/keep-passed');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      total: 3, passed: 1, failed: 2,
      kept_tools: ['GetQuote'], excluded_tools: ['GetBonds', 'GetStocks'],
    });
    const demote = execMock.mock.calls.find((c) => String(c[0]).includes("status = 'candidate'"));
    expect(demote).toBeDefined();
    expect(demote![1]).toEqual(['p1', ['t2', 't3']]);
  });

  it('404s a run from another project', async () => {
    getRunMock.mockResolvedValue({ run: { id: 'run-1', project_id: 'other', summary: '{}' }, results: [] } as any);
    const res = await request(app()).post('/v1/projects/p1/eval/runs/run-1/keep-passed');
    expect(res.status).toBe(404);
    expect(execMock).not.toHaveBeenCalled();
  });
});
