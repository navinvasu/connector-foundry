// EV-05: GET /v1/projects/eval/runs/:runId — certification verdict.
// Runs finished after EV-05 carry the verdict in their stored summary;
// older runs are judged on read from their recorded results.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../db.js', () => ({
  q: vi.fn(),
  J: { parse: (v: any, fb: any) => (v == null ? fb : typeof v === 'string' ? JSON.parse(v) : v) },
}));
vi.mock('../eval.js', () => ({ getRun: vi.fn() }));
vi.mock('../release.js', () => ({
  createRelease: vi.fn(),
  approveRelease: vi.fn(),
  getManifest: vi.fn(),
  rollbackRelease: vi.fn(),
}));
vi.mock('../runtime.js', () => ({
  invoke: vi.fn(),
  telemetrySummary: vi.fn(),
}));
vi.mock('../auth.js', () => ({
  requireProjectRole: () => (_req: any, _res: any, next: any) => next(),
  // BE-09 scoping itself is covered in tenancy.test.ts with the real middleware.
  requireProjectRead: () => (_req: any, _res: any, next: any) => next(),
}));

import { q } from '../db.js';
import { getRun } from '../eval.js';
import { errorHandler } from '../errors.js';
import { evalRouter } from './workflow.js';

const qMock = vi.mocked(q);
const getRunMock = vi.mocked(getRun);

function app() {
  const a = express();
  a.use(express.json());
  a.use((req: any, _res, next) => { req.auth = { userId: 'u1', memberships: [] }; next(); });
  a.use('/v1/projects', evalRouter);
  a.use(errorHandler);
  return a;
}

const SUITES = {
  contract: { status: 'passed', passed: 2, failed: 0 },
  behavior: { status: 'passed', passed: 1, failed: 0 },
  recovery: { status: 'passed', passed: 1, failed: 0 },
  auth: { status: 'not_tested', reason: 'All evaluated tools require no credentials (credential_mode = none).' },
  safety: { status: 'passed' },
};
const RESULTS = [
  { id: 'x1', tool_id: 't1', suite: 'contract', scenario: 'happy_path_2xx_json', passed: true, detail: '{}' },
  { id: 'x2', tool_id: 't1', suite: 'contract', scenario: 'missing_params_handled', passed: true, detail: '{}' },
  { id: 'x3', tool_id: 't1', suite: 'behavior', scenario: 'response_carries_task_fields', passed: true, detail: '{}' },
  { id: 'x4', tool_id: 't1', suite: 'recovery', scenario: 'invalid_input_handled', passed: true, detail: '{}' },
];
const STORED_CERT = {
  certified: true, criteria_version: 'v1',
  checks: [{ id: 'run_passed', label: 'Evaluation run passed', status: 'pass', detail: 'stored' }],
};

beforeEach(() => {
  vi.clearAllMocks();
  qMock.mockResolvedValue([]);
});

describe('GET /v1/projects/eval/runs/:runId (EV-05 certification)', () => {
  it('passes a stored certification verdict through untouched (no recompute)', async () => {
    getRunMock.mockResolvedValue({
      run: {
        id: 'run-1', project_id: 'p1', status: 'passed',
        summary: JSON.stringify({ suites: SUITES, certification: STORED_CERT }),
      },
      results: RESULTS,
    } as any);
    const res = await request(app()).get('/v1/projects/eval/runs/run-1');
    expect(res.status).toBe(200);
    expect(res.body.run.summary.certification).toEqual(STORED_CERT);
    expect(qMock).not.toHaveBeenCalled();
  });

  it('judges a legacy run (no stored verdict) from its recorded results', async () => {
    getRunMock.mockResolvedValue({
      run: { id: 'run-0', project_id: 'p1', status: 'passed', summary: JSON.stringify({ suites: SUITES }) },
      results: RESULTS,
    } as any);
    qMock.mockResolvedValue([{ id: 't1', credential_mode: 'none', effect_classes: ['read_only'] }]);
    const res = await request(app()).get('/v1/projects/eval/runs/run-0');
    expect(res.status).toBe(200);
    const cert = res.body.run.summary.certification;
    expect(cert.certified).toBe(true);
    expect(cert.criteria_version).toBe('v2');
    expect(cert.checks).toHaveLength(7);
    expect(qMock).toHaveBeenCalledTimes(1);
    expect(String(qMock.mock.calls[0]![0])).toContain('FROM canonical_tools');
  });

  it('does not certify a legacy run whose results contain a failure', async () => {
    getRunMock.mockResolvedValue({
      run: { id: 'run-0', project_id: 'p1', status: 'failed', summary: JSON.stringify({ suites: SUITES }) },
      results: RESULTS.map((r) => (r.suite === 'recovery' ? { ...r, passed: false } : r)),
    } as any);
    qMock.mockResolvedValue([{ id: 't1', credential_mode: 'none', effect_classes: ['read_only'] }]);
    const res = await request(app()).get('/v1/projects/eval/runs/run-0');
    expect(res.status).toBe(200);
    expect(res.body.run.summary.certification.certified).toBe(false);
  });

  it('still 404s an unknown run', async () => {
    getRunMock.mockResolvedValue({ run: undefined, results: [] } as any);
    const res = await request(app()).get('/v1/projects/eval/runs/nope');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Eval run not found');
  });
});
