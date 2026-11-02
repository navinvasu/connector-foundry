// BE-02: integration tests — the full Express app (createApp, the exact
// wiring index.ts uses) exercised over HTTP against a scratch PostgreSQL
// database, plus a local stub upstream standing in for the API owner's
// service. Covers the AC end-to-end flow (import → compile → approve →
// eval → release → approve → manifest → invoke) and a route matrix over
// every mounted router (happy paths + 400/404/503 cases).
//
// Run:  createdb connector_foundry_test   (once; or let the suite recreate it)
//       CF_TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/connector_foundry_test npm test
// Skip: when the database is unreachable the whole suite skips, so plain
// `npm test` stays green on machines without Postgres (CI, laptops).
// Auth: CF_DEV_AUTH=true (set explicitly below; SE-07 made the default OFF) — requests run as the seeded
// platform-admin dev user, so every code path runs against real rows.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { Client } from 'pg';

const TEST_DATABASE_URL =
  process.env.CF_TEST_DATABASE_URL ??
  'postgres://postgres:postgres@localhost:5432/connector_foundry_test';

function dbNameOf(url: string): string {
  return new URL(url).pathname.replace(/^\//, '') || 'connector_foundry_test';
}
function adminUrlOf(url: string): string {
  const u = new URL(url);
  u.pathname = '/postgres';
  return u.toString();
}

async function databaseReachable(): Promise<boolean> {
  // Probe the server via the admin database — the test database itself is
  // dropped + recreated in beforeAll, so probing it would always fail here.
  const c = new Client({ connectionString: adminUrlOf(TEST_DATABASE_URL), connectionTimeoutMillis: 3000 });
  try {
    await c.connect();
    await c.end();
    return true;
  } catch {
    return false;
  }
}

// Top-level probe: the suite either runs fully or skips entirely.
const hasDb = await databaseReachable();
const describeDb = (hasDb ? describe : describe.skip) as typeof describe;
if (!hasDb) {
  // eslint-disable-next-line no-console
  console.warn(`[BE-02] skipping integration suite — no Postgres at ${TEST_DATABASE_URL}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describeDb('BE-02 integration: full stack over HTTP against scratch Postgres', () => {
  let api: ReturnType<typeof request>;
  let tick: () => Promise<void>;
  let pool: { end: () => Promise<void> };
  let stubServer: import('node:http').Server;
  let stubPort: number;
  let projectId: string;
  let customerId: string;
  let releaseId: string;
  let latestRunId: string;

  // ——— Stub upstream: a fake "Widget API" the eval harness and the data
  // plane invoke for real over localhost HTTP. ———
  async function startStubUpstream(): Promise<void> {
    const stub = express();
    stub.use(express.json());
    stub.get('/widgets', (req, res) => {
      const count = req.query.count;
      if (count !== undefined) {
        const n = Number(count);
        // Recovery suite: corrupt input (99999) must be *handled* — 4xx.
        if (!Number.isInteger(n) || n < 1 || n > 100) {
          return res.status(400).json({ error: 'count must be an integer between 1 and 100' });
        }
        return res.json({
          widgets: Array.from({ length: n }, (_, i) => ({ id: `w-${i + 1}`, name: `Widget ${i + 1}` })),
          count: n,
        });
      }
      res.json({ widgets: [{ id: 'w-1', name: 'Widget 1' }], count: 1 });
    });
    stub.get('/widgets/:id', (req, res) => {
      res.json({ id: req.params.id, name: `Widget ${req.params.id}` });
    });
    await new Promise<void>((resolve) => {
      stubServer = stub.listen(0, '127.0.0.1', () => resolve());
    });
    stubPort = (stubServer.address() as import('node:net').AddressInfo).port;
  }

  function widgetSpec() {
    return {
      openapi: '3.0.0',
      info: { title: 'Widget API (BE-02 fixture)', version: '1.0.0' },
      servers: [{ url: `http://127.0.0.1:${stubPort}` }],
      paths: {
        '/widgets': {
          get: {
            operationId: 'listWidgets',
            summary: 'List widgets',
            description: 'Returns a paginated list of widgets.',
            parameters: [
              {
                name: 'count',
                in: 'query',
                description: 'How many widgets to return (1-100).',
                schema: { type: 'integer' },
              },
            ],
            responses: { 200: { description: 'A list of widgets' } },
          },
        },
        '/widgets/{id}': {
          get: {
            operationId: 'getWidget',
            summary: 'Get one widget',
            description: 'Returns a single widget by id.',
            parameters: [
              {
                name: 'id',
                in: 'path',
                required: true,
                description: 'The widget id.',
                schema: { type: 'string' },
              },
            ],
            responses: { 200: { description: 'One widget' } },
          },
        },
      },
    };
  }

  /** Drive the queue worker deterministically, then poll the job until done. */
  async function awaitJob(jobId: string, timeoutMs = 90000): Promise<any> {
    const start = Date.now();
    for (;;) {
      await tick().catch(() => undefined);
      const res = await api.get(`/v1/jobs/${jobId}`);
      expect(res.status).toBe(200);
      const job = res.body.job;
      if (job.status === 'succeeded') return job;
      if (job.status === 'failed' || job.status === 'cancelled') {
        throw new Error(`job ${jobId} ${job.status}: ${JSON.stringify(job.error ?? job.result ?? '')}`);
      }
      if (Date.now() - start > timeoutMs) throw new Error(`job ${jobId} did not finish in ${timeoutMs}ms`);
      await sleep(400);
    }
  }

  beforeAll(async () => {
    // Fresh scratch database on every run — the schema applies cleanly and no
    // state leaks between runs.
    const admin = new Client({ connectionString: adminUrlOf(TEST_DATABASE_URL) });
    await admin.connect();
    const name = dbNameOf(TEST_DATABASE_URL);
    await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
    await admin.query(`CREATE DATABASE "${name}"`);
    await admin.end();

    // Point the app's pool at the scratch DB *before* any app module loads
    // (db.ts reads DATABASE_URL at module-eval time).
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    process.env.CF_DEV_AUTH = 'true';
    // SE-08: eval/invoke call the stub upstream on 127.0.0.1, which the
    // egress policy refuses by default — opt in for this suite only.
    process.env.CF_EGRESS_ALLOW_PRIVATE = 'true';

    const db = await import('./db.js');
    await db.applySchema();
    pool = db.pool;

    const { createApp } = await import('./app.js');
    const queue = await import('./queue.js');
    tick = queue.tick;

    await startStubUpstream();
    api = request(createApp());

    // First authenticated request seeds the dev identity (platform-admin user
    // + Dev Workspace customer) via CF_DEV_AUTH.
    const me = await api.get('/v1/me');
    expect(me.status).toBe(200);
    customerId = me.body.memberships[0].customer_id;
  }, 180000);

  afterAll(async () => {
    stubServer?.close();
    await pool?.end();
  });

  // ═══════════════ AC: full import → invoke flow ═══════════════

  it('creates a project (201) and rejects a malformed body (400)', async () => {
    const bad = await api.post('/v1/projects').send({});
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('invalid_request');

    const res = await api.post('/v1/projects').send({ name: 'BE-02 Integration' });
    expect(res.status).toBe(201);
    expect(res.body.project.id).toBeTruthy();
    expect(res.body.project.customer_id).toBe(customerId);
    projectId = res.body.project.id;
  });

  it('imports the fixture spec (201) and rejects bad specs (400)', async () => {
    const badType = await api
      .post(`/v1/projects/${projectId}/sources`)
      .send({ type: 'openapi_yaml', payload: '{}' });
    expect(badType.status).toBe(400);
    expect(badType.body.error).toBe('invalid_request');

    const badSpec = await api
      .post(`/v1/projects/${projectId}/sources`)
      .send({ type: 'openapi_json', payload: { not: 'a spec' } });
    expect(badSpec.status).toBe(400);
    expect(badSpec.body.code).toBe('spec_parse_error');

    const res = await api
      .post(`/v1/projects/${projectId}/sources`)
      .send({ type: 'openapi_json', payload: widgetSpec() });
    expect(res.status).toBe(201);
    expect(res.body.source.operations).toBe(2);
    expect(res.body.inventory.operations.map((o: any) => o.method + ' ' + o.path).sort())
      .toEqual(['GET /widgets', 'GET /widgets/{id}']);
  });

  it('lists sources, operations, and review items', async () => {
    for (const path of ['sources', 'operations', 'review']) {
      const res = await api.get(`/v1/projects/${projectId}/${path}`);
      expect(res.status).toBe(200);
    }
    const ops = await api.get(`/v1/projects/${projectId}/operations`);
    expect(ops.body.operations).toHaveLength(2);
  });

  it('compiles via the queue (202 → succeeded) and lists candidate tools', async () => {
    const enq = await api.post(`/v1/projects/${projectId}/compile`);
    expect(enq.status).toBe(202);
    expect(enq.body.job.kind).toBe('compile');
    await awaitJob(enq.body.job.id);

    const tools = await api.get(`/v1/projects/${projectId}/tools`);
    expect(tools.status).toBe(200);
    expect(tools.body.tools).toHaveLength(2);
    for (const t of tools.body.tools) expect(t.status).toBe('candidate');
  });

  it('approves the tools', async () => {
    const tools = await api.get(`/v1/projects/${projectId}/tools`);
    for (const t of tools.body.tools) {
      const res = await api.patch(`/v1/projects/tools/${t.id}`).send({ status: 'approved' });
      expect(res.status).toBe(200);
    }
  });

  it('blocks release before eval passes (400 release_blocked)', async () => {
    const res = await api.post(`/v1/projects/${projectId}/releases`).send({ version: '0.0.1' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('release_blocked');
    expect(res.body.error).toMatch(/not passed evaluation/);
  });

  it('evals against the live stub upstream (202 → succeeded) and promotes tools to tested', async () => {
    const enq = await api.post(`/v1/projects/${projectId}/eval`);
    expect(enq.status).toBe(202);
    expect(enq.body.job.kind).toBe('eval');
    await awaitJob(enq.body.job.id);

    const runs = await api.get(`/v1/projects/${projectId}/eval/runs`);
    expect(runs.status).toBe(200);
    expect(runs.body.runs.length).toBeGreaterThan(0);
    const latest = runs.body.runs[0];
    latestRunId = latest.id;
    expect(latest.status).toBe('passed');
    const suites = latest.summary.suites;
    expect(suites.contract.status).toBe('passed');
    expect(suites.behavior.status).toBe('passed');
    expect(suites.recovery.status).toBe('passed');
    // No credentials on the fixture tools: auth is honestly "not tested".
    expect(suites.auth.status).toBe('not_tested');

    const tools = await api.get(`/v1/projects/${projectId}/tools`);
    for (const t of tools.body.tools) expect(t.status).toBe('tested');
  });

  it('creates a release (201), approves it, and downloads the manifest', async () => {
    const created = await api.post(`/v1/projects/${projectId}/releases`).send({ version: '1.0.0' });
    expect(created.status).toBe(201);
    expect(created.body.release_id).toBeTruthy();
    expect(created.body.manifest.tools).toHaveLength(2);
    releaseId = created.body.release_id;

    const approved = await api.post(`/v1/releases/${releaseId}/approve`).send({});
    expect(approved.status).toBe(200);
    expect(approved.body.ok).toBe(true);

    const manifest = await api.get(`/v1/releases/${releaseId}/manifest`);
    expect(manifest.status).toBe(200);
    expect(manifest.body.tools.map((t: any) => t.name).sort())
      .toEqual(['getWidget', 'listWidgets']);
  });

  it('invokes both tools against the stub upstream (200, ok)', async () => {
    const list = await api.post('/v1/runtime/invoke').send({
      project_id: projectId,
      version: '1.0.0',
      tool_name: 'listWidgets',
      args: { count: 2 },
    });
    expect(list.status).toBe(200);
    expect(list.body.ok).toBe(true);
    expect(list.body.result.widgets).toHaveLength(2);

    const one = await api.post('/v1/runtime/invoke').send({
      project_id: projectId,
      version: '1.0.0',
      tool_name: 'getWidget',
      args: { id: 'w-7' },
    });
    expect(one.status).toBe(200);
    expect(one.body.ok).toBe(true);
    expect(one.body.result.id).toBe('w-7');
  });

  it('invoke fails cleanly for an unknown version (502, not ok)', async () => {
    const res = await api.post('/v1/runtime/invoke').send({
      project_id: projectId,
      version: '9.9.9',
      tool_name: 'listWidgets',
      args: {},
    });
    expect(res.status).toBe(502);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.condition).toBeTruthy();
  });

  it('telemetry records the invokes; over-plan windows lock instead of erroring', async () => {
    const tel = await api.get(`/v1/projects/${projectId}/telemetry`);
    expect(tel.status).toBe(200);
    expect(tel.body.recent.length).toBeGreaterThan(0);
    expect(tel.body.retention.locked).toBe(false);

    // Starter keeps 90 days — a 4000-day lookback clamps and locks (200, never an error).
    const locked = await api.get(`/v1/projects/${projectId}/telemetry?days=4000`);
    expect(locked.status).toBe(200);
    expect(locked.body.retention.locked).toBe(true);
  });

  it('rolls back the release; the data plane then refuses it (RELEASE_DEPRECATED)', async () => {
    const rb = await api.post(`/v1/releases/${releaseId}/rollback`).send({ reason: 'BE-02 fixture' });
    expect(rb.status).toBe(200);

    const res = await api.post('/v1/runtime/invoke').send({
      project_id: projectId,
      version: '1.0.0',
      tool_name: 'listWidgets',
      args: {},
    });
    expect(res.status).toBe(502);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.condition).toBe('RELEASE_DEPRECATED');
  });

  // ═══════════════ Route matrix: reads ═══════════════

  it('health + me + project reads', async () => {
    const health = await api.get('/health');
    expect(health.status).toBe(200);
    expect(health.body.ok).toBe(true);

    const me = await api.get('/v1/me');
    expect(me.status).toBe(200);
    expect(me.body.user.is_platform_admin).toBe(true);
    expect(me.body.memberships.length).toBeGreaterThan(0);

    const list = await api.get('/v1/projects');
    expect(list.status).toBe(200);
    expect(list.body.projects.some((p: any) => p.id === projectId)).toBe(true);

    const one = await api.get(`/v1/projects/${projectId}`);
    expect(one.status).toBe(200);
    expect(one.body.project.id).toBe(projectId);
  });

  it('404s (not 403s) for unknown/out-of-scope ids — no existence leak', async () => {
    for (const path of [
      '/v1/projects/does-not-exist',
      `/v1/projects/does-not-exist/tools`,
      `/v1/projects/does-not-exist/sources`,
      `/v1/projects/does-not-exist/eval/runs`,
      `/v1/projects/does-not-exist/releases`,
      `/v1/projects/does-not-exist/telemetry`,
      `/v1/projects/does-not-exist/jobs`,
      '/v1/jobs/does-not-exist',
      '/v1/eval/runs/does-not-exist',
      '/v1/releases/does-not-exist/manifest',
    ]) {
      const res = await api.get(path);
      expect(res.status).toBe(404);
    }
  });

  it('rejects malformed pagination (400 invalid_pagination)', async () => {
    const res = await api.get(`/v1/projects/${projectId}/tools?cursor=!!!not-a-cursor!!!`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_pagination');
  });

  it('jobs list + single eval run read', async () => {
    const jobs = await api.get(`/v1/projects/${projectId}/jobs`);
    expect(jobs.status).toBe(200);
    expect(jobs.body.jobs.length).toBeGreaterThanOrEqual(2);
    expect(jobs.body.pagination).toBeTruthy();

    const run = await api.get(`/v1/eval/runs/${latestRunId}`);
    expect(run.status).toBe(200);
    expect(run.body.run.id).toBe(latestRunId);
    expect(run.body.results.length).toBeGreaterThan(0);
  });

  it('admin reads (platform admin)', async () => {
    for (const path of ['/v1/admin/plans', '/v1/admin/customers', '/v1/admin/users']) {
      const res = await api.get(path);
      expect(res.status).toBe(200);
    }
    const plans = await api.get('/v1/admin/plans');
    expect(plans.body.plans.map((p: any) => p.id).sort())
      .toEqual(['growth', 'scale', 'starter', 'trial']);
  });

  it('member roster + usage reads', async () => {
    const users = await api.get(`/v1/customers/${customerId}/users`);
    expect(users.status).toBe(200);
    expect(users.body.members.length).toBeGreaterThan(0);

    const usage = await api.get(`/v1/customers/${customerId}/usage`);
    expect(usage.status).toBe(200);
  });

  it('billing reads without Stripe keys: summary/plans/usage work, money movement 503s', async () => {
    const plans = await api.get('/v1/billing/plans');
    expect(plans.status).toBe(200);

    const summary = await api.get(`/v1/customers/${customerId}/billing`);
    expect(summary.status).toBe(200);
    expect(summary.body.billing_enabled).toBe(false);

    const usage = await api.get(`/v1/customers/${customerId}/billing/usage`);
    expect(usage.status).toBe(200);

    const checkout = await api.post(`/v1/customers/${customerId}/billing/checkout`).send({ plan_id: 'growth' });
    expect(checkout.status).toBe(503);

    // Without invoice_id the endpoint 400s (required param); with one it
    // reaches the Stripe fetch, which 503s without STRIPE_SECRET_KEY.
    const reconMissing = await api.get(`/v1/customers/${customerId}/billing/usage/reconciliation`);
    expect(reconMissing.status).toBe(400);
    const recon = await api.get(
      `/v1/customers/${customerId}/billing/usage/reconciliation?invoice_id=in_test_123`);
    expect(recon.status).toBe(503);
  });

  it('eval report 503s cleanly without report storage configured', async () => {
    const res = await api.get(`/v1/projects/${projectId}/eval/runs/${latestRunId}/report`);
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('report_storage_not_configured');
  });

  it('Stripe webhook refuses unsigned payloads without Stripe keys (503, no 500)', async () => {
    const res = await api.post('/v1/billing/webhook').send({ type: 'ping' });
    expect(res.status).toBe(503);
  });

  it('project export returns the full fixture bundle', async () => {
    const res = await api.get(`/v1/projects/${projectId}/export`);
    expect(res.status).toBe(200);
    expect(res.body.project.id).toBe(projectId);
    expect(res.body.tools).toHaveLength(2);
    expect(res.body.eval_runs.length).toBeGreaterThan(0);
  });

  // ═══════════════ Route matrix: mutations & negative cases ═══════════════

  it('renames the project (PATCH 200)', async () => {
    const res = await api.patch(`/v1/projects/${projectId}`).send({ name: 'BE-02 Integration (renamed)' });
    expect(res.status).toBe(200);
    expect(res.body.project.name).toBe('BE-02 Integration (renamed)');
  });

  it('dismisses a review item', async () => {
    const review = await api.get(`/v1/projects/${projectId}/review`);
    expect(review.status).toBe(200);
    const open = review.body.review_items.filter((i: any) => i.status === 'open');
    if (open.length === 0) return; // fixture spec may produce no findings — acceptable
    const res = await api.patch(`/v1/projects/review/${open[0].id}`).send({ status: 'dismissed' });
    expect(res.status).toBe(200);
  });

  it('rejects invalid review/tool patch bodies (400)', async () => {
    const tools = await api.get(`/v1/projects/${projectId}/tools`);
    const badTool = await api.patch(`/v1/projects/tools/${tools.body.tools[0].id}`).send({ status: 'bogus' });
    expect(badTool.status).toBe(400);
    expect(badTool.body.error).toBe('invalid_request');

    // Unknown review items 404 (existence check runs before body validation);
    // a real item with a bad body 400s.
    const badReviewUnknown = await api.patch('/v1/projects/review/does-not-exist').send({ status: 'bogus' });
    expect(badReviewUnknown.status).toBe(404);
    const review = await api.get(`/v1/projects/${projectId}/review`);
    const itemId = review.body.review_items[0]?.id;
    if (itemId) {
      const badReview = await api.patch(`/v1/projects/review/${itemId}`).send({ status: 'bogus' });
      expect(badReview.status).toBe(400);
      expect(badReview.body.error).toBe('invalid_request');
    }
  });

  it('member invite → role change → remove', async () => {
    const invite = await api
      .post(`/v1/customers/${customerId}/users/invite`)
      .send({ email: 'be02-teammate@example.com', role: 'viewer' });
    expect(invite.status).toBe(201);
    expect(invite.body.invited).toBe(true);
    const userId = invite.body.user.id;

    const badInvite = await api
      .post(`/v1/customers/${customerId}/users/invite`)
      .send({ email: 'not-an-email', role: 'viewer' });
    expect(badInvite.status).toBe(400);

    const changed = await api
      .patch(`/v1/customers/${customerId}/users/${userId}`)
      .send({ role: 'editor' });
    expect(changed.status).toBe(200);

    const removed = await api.delete(`/v1/customers/${customerId}/users/${userId}`);
    expect(removed.status).toBe(200);
  });

  it('invite redemption: sign-in alone does not accept a hashed invite; token redeems once (SE-10)', async () => {
    const email = 'se10-invitee@example.com';
    const invite = await api
      .post(`/v1/customers/${customerId}/users/invite`)
      .send({ email, role: 'viewer' });
    expect(invite.status).toBe(201);
    const token: string = invite.body.invite_token;
    expect(token).toBeTruthy();

    // Public accept-link info: workspace + role, no roster, no emails.
    const info = await api.get(`/v1/invites/${token}`);
    expect(info.status).toBe(200);
    expect(info.body.invite.workspace_name).toBeTruthy();
    expect(JSON.stringify(info.body)).not.toContain(email);

    const rosterStatus = async () => {
      const roster = await api.get(`/v1/customers/${customerId}/users`);
      return roster.body.members.find((m: any) => m.email === email)?.status;
    };

    // A first sign-in (dev persona) must NOT activate a hashed invite —
    // acceptance is token-checked since SE-10 (FE-08 fallback is legacy-only).
    const me = await api.get('/v1/me').set('x-dev-as', email);
    expect(me.status).toBe(200);
    expect(await rosterStatus()).toBe('invited');

    // Signed in as someone else: 403, and the invite stays pending.
    const wrong = await api.post(`/v1/invites/${token}/redeem`).set('x-dev-as', 'se10-other@example.com').send({});
    expect(wrong.status).toBe(403);
    expect(await rosterStatus()).toBe('invited');

    // The invitee redeems: active, and the token is burned.
    const ok = await api.post(`/v1/invites/${token}/redeem`).set('x-dev-as', email).send({});
    expect(ok.status).toBe(200);
    expect(ok.body.customer_id).toBe(customerId);
    expect(await rosterStatus()).toBe('active');

    const replay = await api.post(`/v1/invites/${token}/redeem`).set('x-dev-as', email).send({});
    expect(replay.status).toBe(404);
    const infoAfter = await api.get(`/v1/invites/${token}`);
    expect(infoAfter.status).toBe(404);
  });

  it('admin creates, suspends, and reactivates a customer', async () => {
    const created = await api.post('/v1/admin/customers').send({ name: 'BE-02 Second Customer', plan_id: 'trial' });
    expect(created.status).toBe(201);
    const secondId = created.body.customer.id;

    const fetched = await api.get(`/v1/admin/customers/${secondId}`);
    expect(fetched.status).toBe(200);

    const suspended = await api.post(`/v1/admin/customers/${secondId}/suspend`);
    expect(suspended.status).toBe(200);

    const reactivated = await api.post(`/v1/admin/customers/${secondId}/reactivate`);
    expect(reactivated.status).toBe(200);
  });

  it('admin rejects an unknown plan (400)', async () => {
    const res = await api.post('/v1/admin/customers').send({ name: 'Bad Plan Co', plan_id: 'platinum' });
    expect(res.status).toBe(400);
  });

  it('seat override lets invites past the plan cap, clearing restores it (BL-05)', async () => {
    const created = await api.post('/v1/admin/customers')
      .send({ name: 'BL-05 Seat Co', plan_id: 'trial', owner_email: 'bl05-owner@example.com' });
    expect(created.status).toBe(201);
    const cid = created.body.customer.id;

    // Trial cap is 3 seats: owner (invited) + two invites fill it.
    for (const email of ['bl05-a@example.com', 'bl05-b@example.com']) {
      const inv = await api.post(`/v1/customers/${cid}/users/invite`).send({ email, role: 'viewer' });
      expect(inv.status).toBe(201);
    }
    const blocked = await api.post(`/v1/customers/${cid}/users/invite`)
      .send({ email: 'bl05-c@example.com', role: 'viewer' });
    expect(blocked.status).toBe(409);

    const adjusted = await api.patch(`/v1/admin/customers/${cid}/seats`)
      .send({ seats: 5, reason: 'integration test' });
    expect(adjusted.status).toBe(200);
    expect(adjusted.body.customer.seat_override).toBe(5);

    const allowed = await api.post(`/v1/customers/${cid}/users/invite`)
      .send({ email: 'bl05-c@example.com', role: 'viewer' });
    expect(allowed.status).toBe(201);

    const cleared = await api.patch(`/v1/admin/customers/${cid}/seats`).send({ seats: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.customer.seat_override).toBeNull();
  });

  // ═══════════════ EV-08 / HK-09 / D-89: the agent journey ═══════════════
  // A scripted model stands in for Bedrock / Muse Spark: it calls getWidget
  // for user prompts, answers after a tool result, proposes one argument
  // description fix, and passes the rubric judge.

  it('agent tasks → eval → suggestion → v2 → compare → playground telemetry', async () => {
    const { setLlmClient } = await import('./llm/index.js');
    const base = { toolCalls: [], usage: { inputTokens: 10, outputTokens: 5 }, stopReason: 'end', provider: 'fake', model: 'fake-1' };
    setLlmClient({
      provider: 'fake', model: 'fake-1',
      async chat(req) {
        if (req.system?.includes('grade')) return { ...base, text: '{"pass": true, "reason": "names the widget"}' };
        if (req.system?.includes('improve how')) {
          return { ...base, text: JSON.stringify([{
            tool: 'getWidget', field: 'param_description', param: 'id',
            after: 'Widget id such as "w-7", taken from listWidgets.', rationale: 'Agents guessed ids.', evidence: [],
          }]) };
        }
        const last = req.messages[req.messages.length - 1]!;
        if (last.role === 'user') return { ...base, text: '', toolCalls: [{ id: 'c1', name: 'getWidget', args: { id: 'w-7' } }] };
        return { ...base, text: 'Widget w-7 is called "Widget w-7".' };
      },
    });
    try {
      expect((await api.patch(`/v1/projects/${projectId}`).send({ capture_prompts: true })).status).toBe(200);
      const task = await api.post(`/v1/projects/${projectId}/agent-tasks`).send({
        prompt: 'Show me widget w-7', expected_tools: ['getWidget'], answer_rubric: 'Names widget w-7',
      });
      expect(task.status).toBe(201);

      // Before: eval with the agent suite.
      const enq = await api.post(`/v1/projects/${projectId}/eval`);
      await awaitJob(enq.body.job.id);
      const runs = await api.get(`/v1/projects/${projectId}/eval/runs`);
      const before = runs.body.runs[0];
      expect(before.summary.agent).toMatchObject({ status: 'passed', metrics: { tasks: 1, success_rate: 100 }, model: 'fake-1' });
      const results = await api.get(`/v1/projects/${projectId}/eval/runs/${before.id}/agent-results`);
      expect(results.body.results[0].transcript.steps[0].toolCalls[0]).toMatchObject({ name: 'getWidget', known: true });

      // Suggestion from evidence (the lenient-input review item), accepted.
      const gen = await api.post(`/v1/projects/${projectId}/suggestions/generate`);
      expect(gen.status).toBe(201);
      expect(gen.body.suggestions).toHaveLength(1);
      const accepted = await api.post(`/v1/projects/${projectId}/suggestions/${gen.body.suggestions[0].id}/accept`).send({});
      expect(accepted.status).toBe(200);
      const tools = (await api.get(`/v1/projects/${projectId}/tools`)).body.tools;
      const getWidget = tools.find((t: any) => t.name === 'getWidget');
      expect(getWidget.status).toBe('candidate');
      expect(getWidget.input_schema.properties.id.description).toBe('Widget id such as "w-7", taken from listWidgets.');

      // After: re-approve, re-eval, release 2.0.0, compare against 1.0.0.
      expect((await api.patch(`/v1/projects/tools/${getWidget.id}`).send({ status: 'approved' })).status).toBe(200);
      await awaitJob((await api.post(`/v1/projects/${projectId}/eval`)).body.job.id);
      const v2 = await api.post(`/v1/projects/${projectId}/releases`).send({ version: '2.0.0' });
      expect(v2.status).toBe(201);
      expect((await api.post(`/v1/releases/${v2.body.release_id}/approve`).send({})).status).toBe(200);
      const changes = await api.get(`/v1/releases/${v2.body.release_id}/changes?against=${releaseId}`);
      expect(changes.status).toBe(200);
      expect(changes.body.base.version).toBe('1.0.0');
      expect(changes.body.changes).toEqual([{
        tool: 'getWidget', change: 'changed',
        fields: [{ field: 'param:id', before: 'The widget id.', after: 'Widget id such as "w-7", taken from listWidgets.' }],
      }]);

      // Playground on v2: real data-plane call, attributed and with the prompt captured.
      const play = await api.post(`/v1/projects/${projectId}/playground`).send({ prompt: 'Show me widget w-7', version: '2.0.0' });
      expect(play.status).toBe(200);
      expect(play.body.transcript.stoppedBy).toBe('answer');
      expect(play.body.transcript.steps[0].toolCalls[0].result.ok).toBe(true);
      const tel = await api.get(`/v1/projects/${projectId}/telemetry`);
      expect(tel.body.by_channel).toEqual(expect.arrayContaining([expect.objectContaining({ key: 'playground', calls: 1 })]));
      expect(tel.body.by_trigger).toEqual(expect.arrayContaining([expect.objectContaining({ key: 'user_prompt' })]));
      expect(tel.body.by_release).toEqual(expect.arrayContaining([expect.objectContaining({ key: '2.0.0', calls: 1 })]));
      expect(tel.body.top_prompts[0]).toMatchObject({ prompt: 'Show me widget w-7', calls: 1 });
      expect(tel.body.recent[0]).toMatchObject({ channel: 'playground', client: 'playground', trigger: 'user_prompt', trigger_source: 'declared' });
    } finally {
      setLlmClient(undefined);
    }
  });

  it('deletes a throwaway project and it stays gone (404)', async () => {
    const created = await api.post('/v1/projects').send({ name: 'BE-02 throwaway' });
    expect(created.status).toBe(201);
    const doomed = created.body.project.id;

    const deleted = await api.delete(`/v1/projects/${doomed}`);
    expect(deleted.status).toBe(200);

    const gone = await api.get(`/v1/projects/${doomed}`);
    expect(gone.status).toBe(404);
  });

  it('unknown routes return JSON 404', async () => {
    const res = await api.get('/v1/nope');
    expect(res.status).toBe(404);
    expect(res.body.error).toBeTruthy();
  });
});
