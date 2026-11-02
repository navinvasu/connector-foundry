// EV-03: eval report export — render a finished eval run as a self-contained
// HTML report, store it in S3, and hand the caller a short-lived signed URL
// ("one click → downloadable report" in the console).
//
// Why HTML, not PDF: the AC allows PDF *or* HTML; a dependency-free,
// self-contained HTML file renders identically everywhere and prints to PDF
// from any browser. A headless-Chromium PDF pipeline is a much bigger
// dependency for no extra trust value.
//
// Why hand-rolled SigV4: the server deliberately carries no AWS SDK (the
// same minimal-dependency call as DP-06/BE-07). S3 PUT + presigned GET need
// only HMAC-SHA256 from node:crypto. Credentials come from the standard AWS
// env vars (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY[/ AWS_SESSION_TOKEN])
// and are read at request time, never logged, never stored (SE-01's spirit
// until Secrets Manager lands with IN-01).
//
// Report bodies are evidence, so DP-05 applies: every result detail is run
// through redactValue before rendering (details are already redacted at
// storage time — this is defense in depth for rows written before DP-05),
// and every interpolated string is HTML-escaped.

import { createHash, createHmac } from 'node:crypto';
import { redactValue } from './redact.js';

// ─── rendering ──────────────────────────────────────────────────────────────

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export interface EvalReportRun {
  id: string;
  status: string;
  trigger?: string | null;
  started_at?: string | Date | null;
  created_at?: string | Date | null;
  finished_at?: string | Date | null;
  summary?: {
    suites?: Record<string, { status: string; passed?: number; failed?: number; reason?: string }>;
  } | null;
}

export interface EvalReportResult {
  tool_id: string;
  tool_name?: string;
  suite: string;
  scenario: string;
  passed: boolean;
  latency_ms?: number | null;
  detail?: unknown;
}

export interface EvalReportInput {
  projectId: string;
  projectName: string;
  run: EvalReportRun;
  results: EvalReportResult[];
  generatedAt: Date;
}

function fmtDate(v: string | Date | null | undefined): string {
  if (!v) return '—';
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString();
}

interface SuiteRow { suite: string; status: string; passed?: number; failed?: number; reason?: string }

/** Suite rows come from the run summary when present (it knows about
 *  not_tested suites, e.g. auth with no credentialed tools); otherwise they
 *  are derived from the raw results. */
function suiteRows(input: EvalReportInput): SuiteRow[] {
  const suites = input.run.summary?.suites;
  if (suites && Object.keys(suites).length > 0) {
    return Object.entries(suites).map(([suite, s]) => ({ suite, ...s }));
  }
  const bySuite = new Map<string, { passed: number; failed: number }>();
  for (const r of input.results) {
    const row = bySuite.get(r.suite) ?? { passed: 0, failed: 0 };
    if (r.passed) row.passed += 1; else row.failed += 1;
    bySuite.set(r.suite, row);
  }
  return [...bySuite.entries()].map(([suite, c]) => ({
    suite,
    status: c.failed > 0 ? 'failed' : 'passed',
    passed: c.passed,
    failed: c.failed,
  }));
}

export function renderEvalReportHtml(input: EvalReportInput): string {
  const { run, results } = input;
  const passed = results.filter((r) => r.passed).length;
  const failed = results.length - passed;
  const suites = suiteRows(input);
  const statusTone = run.status === 'passed' ? '#15803d' : run.status === 'failed' ? '#b91c1c' : '#92400e';

  const suiteTable = suites.map((s) => `
        <tr>
          <td>${escapeHtml(s.suite)}</td>
          <td>${escapeHtml(s.status)}</td>
          <td>${s.passed ?? '—'}</td>
          <td>${s.failed ?? '—'}</td>
          <td>${s.reason ? escapeHtml(s.reason) : ''}</td>
        </tr>`).join('');

  const resultRows = results.map((r) => {
    const detail = r.detail === undefined ? '' : JSON.stringify(redactValue(r.detail), null, 2);
    return `
        <tr>
          <td>${escapeHtml(r.tool_name ?? r.tool_id)}</td>
          <td>${escapeHtml(r.suite)}</td>
          <td>${escapeHtml(r.scenario)}</td>
          <td class="${r.passed ? 'pass' : 'fail'}">${r.passed ? 'passed' : 'FAILED'}</td>
          <td>${r.latency_ms ?? '—'}</td>
          <td>${detail ? `<pre>${escapeHtml(detail)}</pre>` : ''}</td>
        </tr>`;
  }).join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Evaluation report — ${escapeHtml(input.projectName)} — run ${escapeHtml(run.id)}</title>
<style>
  body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; margin: 2rem auto; max-width: 960px; padding: 0 1rem; color: #0f172a; }
  h1 { font-size: 1.4rem; margin-bottom: 0.25rem; }
  .meta { color: #475569; font-size: 0.9rem; }
  .status { font-weight: 700; color: ${statusTone}; }
  table { border-collapse: collapse; width: 100%; margin: 1rem 0 2rem; font-size: 0.9rem; }
  th, td { border: 1px solid #cbd5e1; padding: 0.4rem 0.6rem; text-align: left; vertical-align: top; }
  th { background: #f1f5f9; }
  .pass { color: #15803d; font-weight: 600; }
  .fail { color: #b91c1c; font-weight: 600; }
  pre { margin: 0; white-space: pre-wrap; word-break: break-word; font-size: 0.75rem; }
  footer { color: #64748b; font-size: 0.8rem; border-top: 1px solid #e2e8f0; padding-top: 0.75rem; }
</style>
</head>
<body>
  <h1>Evaluation report</h1>
  <p class="meta">
    Project: <strong>${escapeHtml(input.projectName)}</strong> (${escapeHtml(input.projectId)})<br>
    Run: <strong>${escapeHtml(run.id)}</strong> · trigger: ${escapeHtml(run.trigger ?? 'manual')} ·
    status: <span class="status">${escapeHtml(run.status)}</span><br>
    Started: ${escapeHtml(fmtDate(run.started_at ?? run.created_at))} · Finished: ${escapeHtml(fmtDate(run.finished_at))}
  </p>

  <h2>Summary</h2>
  <p>${results.length} scenario result${results.length === 1 ? '' : 's'} — ${passed} passed, ${failed} failed.</p>
  <table>
    <thead><tr><th>Suite</th><th>Status</th><th>Passed</th><th>Failed</th><th>Note</th></tr></thead>
    <tbody>${suiteTable}
    </tbody>
  </table>

  <h2>Scenario results</h2>
  <table>
    <thead><tr><th>Tool</th><th>Suite</th><th>Scenario</th><th>Result</th><th>Latency (ms)</th><th>Detail</th></tr></thead>
    <tbody>${resultRows}
    </tbody>
  </table>

  <footer>
    Generated by Connector Foundry on ${escapeHtml(input.generatedAt.toISOString())}.
    Scenario details are redacted (DP-05) before inclusion.
  </footer>
</body>
</html>`;
}

// ─── S3 store (SigV4, no SDK) ───────────────────────────────────────────────

export interface ReportStoreConfig {
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  prefix: string;
  urlTtlSeconds: number;
}

const MIN_TTL_SECONDS = 60;
const MAX_TTL_SECONDS = 604_800; // SigV4 presign ceiling: 7 days.

/** Report storage config from env, or null when S3 isn't configured (the
 *  route answers 503, following the BL-01 billing pattern). */
export function reportStoreConfig(env: NodeJS.ProcessEnv = process.env): ReportStoreConfig | null {
  const bucket = env.CF_REPORT_S3_BUCKET?.trim();
  const accessKeyId = env.AWS_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.AWS_SECRET_ACCESS_KEY?.trim();
  if (!bucket || !accessKeyId || !secretAccessKey) return null;
  const rawTtl = Number(env.CF_REPORT_URL_TTL_SECONDS);
  const urlTtlSeconds = Number.isFinite(rawTtl) && rawTtl > 0
    ? Math.min(MAX_TTL_SECONDS, Math.max(MIN_TTL_SECONDS, Math.floor(rawTtl)))
    : 3600;
  const prefix = (env.CF_REPORT_S3_PREFIX ?? 'eval-reports').replace(/^\/+|\/+$/g, '') || 'eval-reports';
  return {
    bucket,
    region: env.CF_REPORT_S3_REGION?.trim() || env.AWS_REGION?.trim() || env.AWS_DEFAULT_REGION?.trim() || 'us-east-1',
    accessKeyId,
    secretAccessKey,
    sessionToken: env.AWS_SESSION_TOKEN?.trim() || undefined,
    prefix,
    urlTtlSeconds,
  };
}

export interface AwsCredentials { accessKeyId: string; secretAccessKey: string; sessionToken?: string }
export type CredentialProvider = () => Promise<AwsCredentials>;

/** The SDK's default chain: env, shared profile, then the EC2/ECS role (IN-10 host). */
const defaultCredentialProvider: CredentialProvider = async () => {
  const { defaultProvider } = await import('@aws-sdk/credential-provider-node');
  return defaultProvider()();
};

/**
 * reportStoreConfig, plus role credentials when the bucket is set but no
 * static keys are: on the hosted stack the instance role is the identity.
 * Null when there is no bucket or no credentials anywhere (route → 503).
 * Resolved per request, so rotated role credentials are always current.
 */
export async function resolveReportStoreConfig(
  env: NodeJS.ProcessEnv = process.env,
  provider: CredentialProvider = defaultCredentialProvider,
): Promise<ReportStoreConfig | null> {
  const fromEnv = reportStoreConfig(env);
  if (fromEnv || !env.CF_REPORT_S3_BUCKET?.trim()) return fromEnv;
  try {
    const creds = await provider();
    return reportStoreConfig({
      ...env,
      AWS_ACCESS_KEY_ID: creds.accessKeyId,
      AWS_SECRET_ACCESS_KEY: creds.secretAccessKey,
      AWS_SESSION_TOKEN: creds.sessionToken ?? '',
    });
  } catch {
    return null;
  }
}

function sanitizeSegment(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, '-');
}

export function reportKeyFor(cfg: ReportStoreConfig, projectId: string, runId: string): string {
  return `${cfg.prefix}/${sanitizeSegment(projectId)}/${sanitizeSegment(runId)}.html`;
}

// AWS SigV4 UriEncode: unreserved characters pass through, everything else
// is uppercase %XX. Slashes are kept when encoding a full key path.
function uriEncode(value: string, encodeSlash = true): string {
  let out = '';
  for (const ch of value) {
    if (/[A-Za-z0-9\-_.~]/.test(ch)) out += ch;
    else if (ch === '/' && !encodeSlash) out += ch;
    else out += `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

function sha256Hex(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

function signingKey(secret: string, dateStamp: string, region: string): Buffer {
  const kDate = hmac(`AWS4${secret}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, 's3');
  return hmac(kService, 'aws4_request');
}

function amzDates(now: Date): { amzDate: string; dateStamp: string } {
  const iso = now.toISOString(); // 2026-10-01T12:00:00.000Z
  const dateStamp = iso.slice(0, 10).replace(/-/g, '');
  const amzDate = `${dateStamp}T${iso.slice(11, 19).replace(/:/g, '')}Z`;
  return { amzDate, dateStamp };
}

function hostFor(cfg: ReportStoreConfig): string {
  return `${cfg.bucket}.s3.${cfg.region}.amazonaws.com`;
}

/** Presigned GET URL for a stored report. Pure given (cfg, key, now) so the
 *  signature is deterministic under test. */
export function presignedReportUrl(
  cfg: ReportStoreConfig,
  key: string,
  now: Date = new Date(),
): { url: string; expiresAt: Date } {
  const { amzDate, dateStamp } = amzDates(now);
  const credentialScope = `${dateStamp}/${cfg.region}/s3/aws4_request`;
  const canonicalUri = `/${uriEncode(key, false)}`;
  const params: Array<[string, string]> = [
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Credential', `${cfg.accessKeyId}/${credentialScope}`],
    ['X-Amz-Date', amzDate],
    ['X-Amz-Expires', String(cfg.urlTtlSeconds)],
    ['X-Amz-SignedHeaders', 'host'],
  ];
  if (cfg.sessionToken) params.push(['X-Amz-Security-Token', cfg.sessionToken]);
  const canonicalQuery = params
    .slice()
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${uriEncode(k)}=${uriEncode(v)}`)
    .join('&');
  const canonicalRequest = [
    'GET', canonicalUri, canonicalQuery, `host:${hostFor(cfg)}`, '', 'host', 'UNSIGNED-PAYLOAD',
  ].join('\n');
  const stringToSign = [
    'AWS4-HMAC-SHA256', amzDate, credentialScope, sha256Hex(canonicalRequest),
  ].join('\n');
  const signature = createHmac('sha256', signingKey(cfg.secretAccessKey, dateStamp, cfg.region))
    .update(stringToSign, 'utf8')
    .digest('hex');
  return {
    url: `https://${hostFor(cfg)}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`,
    expiresAt: new Date(now.getTime() + cfg.urlTtlSeconds * 1000),
  };
}

type FetchImpl = (url: string, init: Record<string, unknown>) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

/** Upload the rendered report to S3 with a SigV4-signed PUT. Throws a plain
 *  Error (status + truncated body, never credentials) on a non-2xx answer;
 *  the route maps it to 502 report_upload_failed. */
export async function uploadReportHtml(
  cfg: ReportStoreConfig,
  key: string,
  html: string,
  fetchImpl: FetchImpl = fetch as unknown as FetchImpl,
  now: Date = new Date(),
): Promise<void> {
  const { amzDate, dateStamp } = amzDates(now);
  const credentialScope = `${dateStamp}/${cfg.region}/s3/aws4_request`;
  const host = hostFor(cfg);
  const canonicalUri = `/${uriEncode(key, false)}`;
  const payloadHash = sha256Hex(html);

  const headerValues: Record<string, string> = {
    'content-type': 'text/html; charset=utf-8',
    host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };
  if (cfg.sessionToken) headerValues['x-amz-security-token'] = cfg.sessionToken;
  const signedHeaders = Object.keys(headerValues).sort().join(';');
  const canonicalHeaders = Object.keys(headerValues).sort()
    .map((k) => `${k}:${headerValues[k]}\n`).join('');
  const canonicalRequest = [
    'PUT', canonicalUri, '', canonicalHeaders, signedHeaders, payloadHash,
  ].join('\n');
  const stringToSign = [
    'AWS4-HMAC-SHA256', amzDate, credentialScope, sha256Hex(canonicalRequest),
  ].join('\n');
  const signature = createHmac('sha256', signingKey(cfg.secretAccessKey, dateStamp, cfg.region))
    .update(stringToSign, 'utf8')
    .digest('hex');

  const headers: Record<string, string> = {
    'Content-Type': 'text/html; charset=utf-8',
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
    Authorization: `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
  if (cfg.sessionToken) headers['x-amz-security-token'] = cfg.sessionToken;

  const res = await fetchImpl(`https://${host}${canonicalUri}`, { method: 'PUT', headers, body: html });
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).slice(0, 200);
    throw new Error(`S3 upload failed: ${res.status}${body ? ` ${body}` : ''}`);
  }
}
