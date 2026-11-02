// EV-03: GET /v1/projects/:id/eval/runs/:runId/report — signed-URL export.
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
vi.mock('../report.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual, // real renderEvalReportHtml + reportKeyFor
    resolveReportStoreConfig: vi.fn(),
    uploadReportHtml: vi.fn(),
    presignedReportUrl: vi.fn(),
  };
});

import { q } from '../db.js';
import { getRun } from '../eval.js';
import { resolveReportStoreConfig, uploadReportHtml, presignedReportUrl, type ReportStoreConfig } from '../report.js';
import { errorHandler } from '../errors.js';
import { evalRouter } from './workflow.js';

const qMock = vi.mocked(q);
const getRunMock = vi.mocked(getRun);
const configMock = vi.mocked(resolveReportStoreConfig);
const uploadMock = vi.mocked(uploadReportHtml);
const presignMock = vi.mocked(presignedReportUrl);

const CFG: ReportStoreConfig = {
  bucket: 'cf-reports', region: 'us-east-1', accessKeyId: 'fake-access-key',
  secretAccessKey: 'fake-secret-key', prefix: 'eval-reports', urlTtlSeconds: 3600,
};

function app() {
  const a = express();
  a.use(express.json());
  a.use((req: any, _res, next) => { req.auth = { userId: 'u1', memberships: [] }; next(); });
  a.use('/v1/projects', evalRouter);
  a.use(errorHandler);
  return a;
}

const RUN = {
  id: 'run-1', project_id: 'p1', status: 'passed', trigger: 'manual',
  started_at: '2026-10-01T10:00:00.000Z', finished_at: '2026-10-01T10:01:00.000Z',
  summary: JSON.stringify({ suites: { contract: { status: 'passed', passed: 1, failed: 0 } } }),
};
const RESULTS = [{
  id: 'x1', tool_id: 't1', suite: 'contract', scenario: 'happy_path_2xx_json',
  passed: true, latency_ms: 12, detail: JSON.stringify({ status: 200 }),
}];

beforeEach(() => {
  vi.clearAllMocks();
  configMock.mockResolvedValue(CFG);
  uploadMock.mockResolvedValue(undefined);
  presignMock.mockReturnValue({
    url: 'https://signed.example/report.html',
    expiresAt: new Date('2026-10-01T13:00:00.000Z'),
  });
  getRunMock.mockResolvedValue({ run: RUN, results: RESULTS } as any);
  qMock.mockResolvedValue([]);
});

describe('GET /v1/projects/:id/eval/runs/:runId/report (EV-03)', () => {
  it('503s with report_storage_not_configured when S3 is not configured', async () => {
    configMock.mockResolvedValue(null);
    const res = await request(app()).get('/v1/projects/p1/eval/runs/run-1/report');
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('report_storage_not_configured');
    expect(getRunMock).not.toHaveBeenCalled();
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('404s an unknown run', async () => {
    getRunMock.mockResolvedValue({ run: undefined, results: [] } as any);
    const res = await request(app()).get('/v1/projects/p1/eval/runs/nope/report');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Eval run not found');
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it("404s a run that belongs to another project (no existence leak)", async () => {
    getRunMock.mockResolvedValue({ run: { ...RUN, project_id: 'p2' }, results: RESULTS } as any);
    const res = await request(app()).get('/v1/projects/p1/eval/runs/run-1/report');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Eval run not found');
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it('renders, uploads, and answers with the signed URL on the happy path', async () => {
    qMock
      .mockResolvedValueOnce([{ name: 'Acme Billing' }])
      .mockResolvedValueOnce([{ id: 't1', name: 'getForecast' }]);
    const res = await request(app()).get('/v1/projects/p1/eval/runs/run-1/report');
    expect(res.status).toBe(200);
    expect(res.body.report).toEqual({
      run_id: 'run-1',
      format: 'html',
      url: 'https://signed.example/report.html',
      expires_at: '2026-10-01T13:00:00.000Z',
      size_bytes: expect.any(Number),
    });
    expect(res.body.report.size_bytes).toBeGreaterThan(0);
    expect(uploadMock).toHaveBeenCalledTimes(1);
    const [cfgArg, keyArg, htmlArg] = uploadMock.mock.calls[0]!;
    expect(cfgArg).toBe(CFG);
    expect(keyArg).toBe('eval-reports/p1/run-1.html');
    expect(String(htmlArg)).toContain('Acme Billing');
    expect(String(htmlArg)).toContain('getForecast'); // tool_id resolved to its name
    expect(presignMock).toHaveBeenCalledWith(CFG, 'eval-reports/p1/run-1.html', expect.any(Date));
  });

  it('maps an S3 failure to a clean 502 (no upstream error body leaks)', async () => {
    uploadMock.mockRejectedValue(new Error('S3 upload failed: 403 AccessDenied fake-secret-key'));
    const res = await request(app()).get('/v1/projects/p1/eval/runs/run-1/report');
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('report_upload_failed');
    expect(JSON.stringify(res.body)).not.toContain('fake-secret-key');
    expect(JSON.stringify(res.body)).not.toContain('AccessDenied');
  });
});
