// End-to-end smoke run (developer tool): drives the full Connector Foundry
// flow over HTTP against a running server, for ANY OpenAPI/Postman source:
//   reset the "Test - Twelve Data" project → import → (credential) →
//   compile → approve → eval → release → approve → invoke → telemetry →
//   delete the project (unless --keep)
//
//   npm run smoke -- --spec-url https://api.example.com/openapi.json
//   npm run smoke -- --spec-file ./spec.json --api-key "$KEY" --keep
//
// Auth: CF_TOKEN (a Cognito access token) when set, else the local dev
// login (CF_DEV_AUTH=true on the server). CF_BASE picks the server.

import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { buildArgs } from './sample-args.js';
import { smokeHintFor } from './smoke-hint.js';
import { SMOKE_PROJECT_NAME, SMOKE_TARGETS, smokeResetIds } from './smoke-reset.js';

const { values: opts } = parseArgs({
  options: {
    'spec-url': { type: 'string' },
    'spec-file': { type: 'string' },
    'api-key': { type: 'string' },
    keep: { type: 'boolean', default: false },
  },
});
if (!opts['spec-url'] && !opts['spec-file']) {
  console.error('Usage: npm run smoke -- --spec-url <url> | --spec-file <path> [--api-key <key>] [--keep]');
  process.exit(2);
}

const BASE = process.env.CF_BASE ?? 'http://localhost:4000';
const TOKEN = process.env.CF_TOKEN;

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
  return json;
}

const step = (n: number, label: string) => console.log(`\n── [${n}] ${label}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Compile and eval are asynchronous (BE-15): poll the job until it ends.
async function waitForJob(jobId: string, label: string, timeoutMs = 300_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { job } = await call('GET', `/v1/jobs/${jobId}`);
    if (job.status === 'succeeded') return job;
    if (job.status === 'failed' || job.status === 'cancelled') {
      throw new Error(`${label} job ${jobId} ${job.status}: ${job.error ?? 'no error detail'}`);
    }
    if (Date.now() > deadline) throw new Error(`${label} job ${jobId} still ${job.status} after ${timeoutMs / 1000}s`);
    await sleep(1000);
  }
}

let projectId: string | null = null;

try {
  step(1, `Reset + create project "${SMOKE_PROJECT_NAME}"`);
  const listed = await call('GET', '/v1/projects');
  for (const id of smokeResetIds((listed as any).projects ?? [])) {
    await call('DELETE', `/v1/projects/${id}`);
    console.log('   deleted previous:', id);
  }
  const { project } = await call('POST', '/v1/projects', {
    name: SMOKE_PROJECT_NAME, description: 'Reset and recreated by npm run smoke on every run',
    targets: SMOKE_TARGETS,
  });
  projectId = project.id as string;
  console.log('   project:', projectId, 'targets:', (project.targets ?? SMOKE_TARGETS).join('+'));

  step(2, 'Import source');
  const source = opts['spec-url']
    ? { type: 'openapi_url', payload: opts['spec-url'] }
    : { type: 'openapi_text', payload: readFileSync(opts['spec-file']!, 'utf8') };
  const imported = await call('POST', `/v1/projects/${projectId}/sources`, source);
  console.log(`   ${imported.source.operations} operations, ${imported.inventory.findings.length} findings`);

  if (opts['api-key']) {
    step(3, 'Store the API key in the vault');
    try {
      await call('POST', `/v1/projects/${projectId}/credentials`, { label: 'smoke', value: opts['api-key'] });
    } catch (e: any) {
      const hint = smokeHintFor(String(e?.message ?? e));
      if (hint) throw new Error(hint);
      throw e;
    }
    console.log('   stored (value never echoed)');
  }

  step(4, 'Compile + approve tools');
  const compiled = await call('POST', `/v1/projects/${projectId}/compile`);
  await waitForJob(compiled.job.id, 'compile');
  const { tools } = await call('GET', `/v1/projects/${projectId}/tools?limit=100`);
  for (const t of tools) await call('PATCH', `/v1/projects/tools/${t.id}`, { status: 'approved' });
  console.log(`   ${tools.length} tools approved`);

  step(5, 'Evaluate against the live upstream');
  const evalRes = await call('POST', `/v1/projects/${projectId}/eval`);
  const evalJob = await waitForJob(evalRes.job.id, 'eval');
  const runId = (evalJob.result as any)?.run_id as string | undefined;
  const runRes = runId ? await call('GET', `/v1/eval/runs/${runId}`) : null;
  const run = (runRes as any)?.run ?? runRes;
  const summary = typeof run?.summary === 'string' ? JSON.parse(run.summary) : (run?.summary ?? {});
  console.log('   run:', run?.id ?? runId, '→', run?.status);
  console.log('   suites:', JSON.stringify(summary?.suites ?? {}));

  step(6, 'Create + approve release 0.1.0');
  const rel = await call('POST', `/v1/projects/${projectId}/releases`, { version: '0.1.0' });
  await call('POST', `/v1/releases/${rel.release_id}/approve`, { approver: 'smoke' });
  console.log('   manifest tools:', rel.manifest.tools.length);

  step(7, 'Invoke a read-only tool through the data plane');
  const readTool = tools.find((t: any) => {
    const classes = typeof t.effect_classes === 'string' ? JSON.parse(t.effect_classes) : t.effect_classes;
    return Array.isArray(classes) && classes.every((c: string) => c === 'read_only');
  }) ?? tools[0];
  const inv = await call('POST', '/v1/runtime/invoke', {
    project_id: projectId, version: '0.1.0', tool_name: readTool.name, args: buildArgs(readTool),
  });
  console.log(`   ${readTool.name}: ok=${inv.ok} latency=${inv.latency_ms}ms`, inv.ok ? '' : JSON.stringify(inv.error));

  step(8, 'Telemetry');
  const tel = await call('GET', `/v1/projects/${projectId}/telemetry`);
  console.log('   by_status:', JSON.stringify(tel.by_status));

  console.log(inv.ok ? '\n✅ Smoke run passed.' : '\n⚠️  Flow completed, but the invoke failed (see above).');
  if (!inv.ok) process.exitCode = 1;
} catch (e) {
  console.error('\n❌', e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  if (projectId && !opts.keep) {
    await call('DELETE', `/v1/projects/${projectId}`).then(
      () => console.log('   project deleted'),
      (e) => console.error('   could not delete the project:', e instanceof Error ? e.message : e),
    );
  }
}
