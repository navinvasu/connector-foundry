import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  escapeHtml,
  renderEvalReportHtml,
  reportStoreConfig,
  resolveReportStoreConfig,
  reportKeyFor,
  presignedReportUrl,
  uploadReportHtml,
  type ReportStoreConfig,
} from './report.js';

const cfg: ReportStoreConfig = {
  bucket: 'cf-reports',
  region: 'us-east-1',
  accessKeyId: 'fake-access-key',
  secretAccessKey: 'fake-secret-key',
  prefix: 'eval-reports',
  urlTtlSeconds: 3600,
};

const NOW = new Date('2026-10-01T12:00:00.000Z');

describe('escapeHtml', () => {
  it('escapes the five HTML-significant characters', () => {
    expect(escapeHtml(`<a href="x">&'`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;');
  });
});

describe('renderEvalReportHtml', () => {
  const baseRun = {
    id: 'run-1',
    status: 'failed',
    trigger: 'manual',
    started_at: '2026-10-01T10:00:00.000Z',
    finished_at: '2026-10-01T10:01:00.000Z',
    summary: {
      suites: {
        contract: { status: 'passed', passed: 2, failed: 0 },
        auth: { status: 'not_tested', reason: 'All evaluated tools require no credentials.' },
      },
    },
  };
  const results = [
    { tool_id: 't1', tool_name: 'getForecast', suite: 'contract', scenario: 'happy_path_2xx_json', passed: true, latency_ms: 42, detail: { status: 200 } },
    { tool_id: 't1', tool_name: 'getForecast', suite: 'recovery', scenario: 'invalid_input_handled', passed: false, latency_ms: 7, detail: { url: 'https://api.test/x?api_key=secret123' } },
  ];

  it('renders project, run, suite summary, and per-scenario results', () => {
    const html = renderEvalReportHtml({ projectId: 'p1', projectName: 'Acme Billing', run: baseRun, results, generatedAt: NOW });
    expect(html).toContain('Acme Billing');
    expect(html).toContain('run-1');
    expect(html).toContain('2 scenario results — 1 passed, 1 failed');
    expect(html).toContain('contract');
    expect(html).toContain('not_tested');
    expect(html).toContain('All evaluated tools require no credentials.');
    expect(html).toContain('getForecast');
    expect(html).toContain('invalid_input_handled');
    expect(html).toContain('FAILED');
  });

  it('escapes HTML in tool names, project names, and details', () => {
    const html = renderEvalReportHtml({
      projectId: 'p1',
      projectName: '<script>alert(1)</script>',
      run: baseRun,
      results: [{ tool_id: 't1', tool_name: '<img src=x onerror=alert(1)>', suite: 'contract', scenario: 's', passed: true, latency_ms: 1, detail: { note: '<b>bold</b>' } }],
      generatedAt: NOW,
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&lt;b&gt;bold&lt;/b&gt;');
  });

  it('redacts secrets inside result details (DP-05 defense in depth)', () => {
    const html = renderEvalReportHtml({ projectId: 'p1', projectName: 'Acme', run: baseRun, results, generatedAt: NOW });
    expect(html).not.toContain('secret123');
    expect(html).toContain('REDACTED');
  });

  it('derives suite rows from results when the run has no summary', () => {
    const html = renderEvalReportHtml({
      projectId: 'p1', projectName: 'Acme',
      run: { ...baseRun, summary: null },
      results,
      generatedAt: NOW,
    });
    expect(html).toContain('contract');
    expect(html).toContain('recovery');
  });
});

describe('reportStoreConfig', () => {
  it('is null until bucket and AWS credentials are all present', () => {
    expect(reportStoreConfig({})).toBeNull();
    expect(reportStoreConfig({ CF_REPORT_S3_BUCKET: 'b' })).toBeNull();
    expect(reportStoreConfig({ CF_REPORT_S3_BUCKET: 'b', AWS_ACCESS_KEY_ID: 'k' })).toBeNull();
    expect(reportStoreConfig({ AWS_ACCESS_KEY_ID: 'k', AWS_SECRET_ACCESS_KEY: 's' })).toBeNull();
  });

  it('applies defaults (region us-east-1, prefix eval-reports, TTL 1h)', () => {
    const c = reportStoreConfig({ CF_REPORT_S3_BUCKET: 'b', AWS_ACCESS_KEY_ID: 'k', AWS_SECRET_ACCESS_KEY: 's' })!;
    expect(c).toMatchObject({ bucket: 'b', region: 'us-east-1', prefix: 'eval-reports', urlTtlSeconds: 3600 });
  });

  it('honors region/prefix overrides and clamps the TTL to [60, 7 days]', () => {
    const base = { CF_REPORT_S3_BUCKET: 'b', AWS_ACCESS_KEY_ID: 'k', AWS_SECRET_ACCESS_KEY: 's', AWS_REGION: 'eu-west-1', CF_REPORT_S3_PREFIX: '/reports/' };
    expect(reportStoreConfig(base)).toMatchObject({ region: 'eu-west-1', prefix: 'reports' });
    expect(reportStoreConfig({ ...base, CF_REPORT_URL_TTL_SECONDS: '30' })!.urlTtlSeconds).toBe(60);
    expect(reportStoreConfig({ ...base, CF_REPORT_URL_TTL_SECONDS: '99999999' })!.urlTtlSeconds).toBe(604_800);
    expect(reportStoreConfig({ ...base, CF_REPORT_URL_TTL_SECONDS: 'abc' })!.urlTtlSeconds).toBe(3600);
  });
});

describe('reportKeyFor', () => {
  it('builds prefix/project/run.html and sanitizes unsafe characters', () => {
    expect(reportKeyFor(cfg, 'p1', 'run-1')).toBe('eval-reports/p1/run-1.html');
    expect(reportKeyFor(cfg, 'p 1/x', 'r?2')).toBe('eval-reports/p-1-x/r-2.html');
  });
});

describe('presignedReportUrl', () => {
  it('produces a deterministic SigV4 query-signed URL with the right scope and expiry', () => {
    const { url, expiresAt } = presignedReportUrl(cfg, 'eval-reports/p1/run-1.html', NOW);
    expect(url).toMatch(/^https:\/\/cf-reports\.s3\.us-east-1\.amazonaws\.com\/eval-reports\/p1\/run-1\.html\?/);
    expect(url).toContain('X-Amz-Algorithm=AWS4-HMAC-SHA256');
    expect(url).toContain('X-Amz-Credential=fake-access-key%2F20261001%2Fus-east-1%2Fs3%2Faws4_request');
    expect(url).toContain('X-Amz-Date=20261001T120000Z');
    expect(url).toContain('X-Amz-Expires=3600');
    expect(url).toContain('X-Amz-SignedHeaders=host');
    expect(url).toMatch(/X-Amz-Signature=[0-9a-f]{64}$/);
    expect(expiresAt.toISOString()).toBe('2026-10-01T13:00:00.000Z');
    // Deterministic for the same inputs; a different key signs differently.
    expect(presignedReportUrl(cfg, 'eval-reports/p1/run-1.html', NOW).url).toBe(url);
    expect(presignedReportUrl(cfg, 'eval-reports/p1/run-2.html', NOW).url).not.toBe(url);
  });

  it('includes the session token in the signed query when present', () => {
    const { url } = presignedReportUrl({ ...cfg, sessionToken: 'tok123' }, 'eval-reports/p1/run-1.html', NOW);
    expect(url).toContain('X-Amz-Security-Token=tok123');
  });
});

describe('uploadReportHtml', () => {
  it('PUTs the HTML with a SigV4 Authorization header and payload hash', async () => {
    const html = '<html>report</html>';
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, text: async () => '' }));
    await uploadReportHtml(cfg, 'eval-reports/p1/run-1.html', html, fetchImpl as any, NOW);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, any];
    expect(url).toBe('https://cf-reports.s3.us-east-1.amazonaws.com/eval-reports/p1/run-1.html');
    expect(init.method).toBe('PUT');
    expect(init.body).toBe(html);
    const payloadHash = createHash('sha256').update(html, 'utf8').digest('hex');
    expect(init.headers['x-amz-content-sha256']).toBe(payloadHash);
    expect(init.headers.Authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=fake-access-key\/20261001\/us-east-1\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/,
    );
  });

  it('throws with the status (and no credentials) when S3 refuses', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 403, text: async () => 'AccessDenied' }));
    await expect(uploadReportHtml(cfg, 'k.html', '<html/>', fetchImpl as any, NOW))
      .rejects.toThrow('S3 upload failed: 403');
    await expect(uploadReportHtml(cfg, 'k.html', '<html/>', fetchImpl as any, NOW))
      .rejects.not.toThrow('fake-secret-key');
  });
});

describe('resolveReportStoreConfig (host role credentials)', () => {
  const role = async () => ({ accessKeyId: 'ROLEKEY', secretAccessKey: 'rolesecret', sessionToken: 'tok' });

  it('uses static env keys when present, without calling the provider', async () => {
    let called = false;
    const c = await resolveReportStoreConfig(
      { CF_REPORT_S3_BUCKET: 'b', AWS_ACCESS_KEY_ID: 'k', AWS_SECRET_ACCESS_KEY: 's' },
      async () => { called = true; return role(); });
    expect(c!.accessKeyId).toBe('k');
    expect(called).toBe(false);
  });

  it('falls back to the role chain when only the bucket is configured', async () => {
    const c = await resolveReportStoreConfig({ CF_REPORT_S3_BUCKET: 'b' }, role);
    expect(c).toMatchObject({ bucket: 'b', accessKeyId: 'ROLEKEY', sessionToken: 'tok' });
  });

  it('is null without a bucket, or when no credentials resolve', async () => {
    expect(await resolveReportStoreConfig({}, role)).toBeNull();
    expect(await resolveReportStoreConfig({ CF_REPORT_S3_BUCKET: 'b' }, async () => { throw new Error('none'); })).toBeNull();
  });
});
