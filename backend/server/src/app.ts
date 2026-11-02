// Connector Foundry Express app factory (BE-02).
//
// The full route wiring lived inline in index.ts, which runs main() on
// import — so no test could boot the real app. createApp() builds the exact
// same middleware + router stack (same order: request ids, security headers,
// raw-body Stripe webhook before express.json(), auth gates, 404/error
// terminal handlers) without listening, migrating, or starting the queue
// worker. index.ts uses it for the real server; integration tests use it
// against a scratch database.

import express from 'express';
import { projectsRouter, toolsRouter } from './routes/tools.js';
import { sourcesRouter } from './routes/sources.js';
import { evalRouter, releasesRouter, runtimeRouter } from './routes/workflow.js';
import { evalScenariosRouter } from './routes/eval-scenarios.js';
import { adminRouter } from './routes/admin.js';
import { membersRouter } from './routes/members.js';
import { billingRouter, billingWebhookRouter } from './routes/billing.js';
import { meRouter } from './routes/me.js';
import { jobsRouter, jobRouter } from './routes/jobs.js';
import { credentialsRouter } from './routes/credentials.js';
import { gatewayKeysRouter } from './routes/gateway-keys.js';
import { mcpRouter } from './routes/mcp.js';
import { gptActionsRouter } from './routes/gpt-actions.js';
import { invitesRouter } from './routes/invites.js';
import { driftRouter } from './routes/drift.js';
import { agentRouter } from './routes/agent.js';
import { suggestionsRouter } from './routes/suggestions.js';
import { apiDocsRouter } from './api-docs.js';
import { requireAuth, requirePlatformAdmin } from './auth.js';
import { errorHandler, notFoundHandler } from './errors.js';
import { requestMiddleware } from './logger.js';
import { applySecurity } from './security.js';

export function createApp(): express.Express {
  const app = express();

  app.use(requestMiddleware());
  // SE-03: hardening headers on every response + CORS locked to the
  // CF_CORS_ORIGINS allowlist (fail-closed in production).
  applySecurity(app);
  // Stripe webhook BEFORE express.json(): signature verification needs the raw body.
  app.use(billingWebhookRouter);
  // RL-03: the MCP router parses its own bodies (JSON-RPC parse errors,
  // not the platform envelope), so it mounts ahead of the global parser.
  app.use('/v1/mcp', mcpRouter);
  app.use(express.json({ limit: '5mb' }));
  // RL-04: GPT Actions execution surface — gateway-key auth inside the
  // router (DP-07 parity with the MCP endpoint), no human JWT.
  app.use('/v1/gpt-actions', gptActionsRouter);

  app.get('/health', (_req, res) => res.json({ ok: true, service: 'connector-foundry-server', version: '0.1.0' }));

  // CD-02: public API contract — GET /v1/openapi.json + GET /v1/docs.
  // No auth: the document holds placeholders only, never secrets.
  app.use('/v1', apiDocsRouter);

  app.use('/v1/projects', requireAuth, projectsRouter);   // GET /, POST /, PATCH /:id, GET /:id/export, DELETE /:id
  app.use('/v1/projects', requireAuth, sourcesRouter);    // POST /:id/sources, GET /:id/sources|operations|review
  app.use('/v1/projects', requireAuth, toolsRouter);      // POST /:id/compile, GET /:id/tools, PATCH /tools/:toolId
  app.use('/v1/projects', requireAuth, jobsRouter);      // POST /:id/compile|eval, GET /:id/jobs
  app.use('/v1', requireAuth, jobRouter);               // GET /v1/jobs/:jobId
  app.use('/v1/projects', requireAuth, evalRouter);       // GET /:id/eval/runs
  app.use('/v1/projects', requireAuth, evalScenariosRouter); // GET|POST|PATCH|DELETE /:id/tools/:toolId/eval-scenarios (EV-04)
  app.use('/v1', requireAuth, evalRouter);                // GET /eval/runs/:runId
  app.use('/v1/projects', requireAuth, releasesRouter);   // POST /:id/releases, GET /:id/releases
  app.use('/v1/releases', requireAuth, releasesRouter);   // POST /:releaseId/approve, GET /:releaseId/manifest
  app.use('/v1/projects', requireAuth, runtimeRouter);    // GET /:id/telemetry
  app.use('/v1/projects', requireAuth, driftRouter);      // GET /:id/drift/alerts|checks, POST /:id/drift/check
  app.use('/v1/projects', requireAuth, agentRouter);      // EV-08: /:id/agent-tasks*, /:id/eval/runs/:runId/agent-results, /:id/playground
  app.use('/v1/projects', requireAuth, suggestionsRouter); // HK-09: /:id/suggestions*
  // DP-07: /v1/runtime carries its own auth dispatcher (gateway key OR
  // human JWT + role gate, in routes/workflow.ts) — no blanket requireAuth
  // here, or key-only callers would 401 before the dispatcher runs.
  app.use('/v1/runtime', runtimeRouter);      // POST /invoke
  // AB-02: credential broker control API — capture / list / rotate / revoke
  // project API keys. Mutations 503 until the vault is configured.
  app.use('/v1/projects', requireAuth, credentialsRouter); // POST|GET /:id/credentials, POST /:id/credentials/:credId/rotate|revoke
  // DP-07: gateway API key control API — mint / list / revoke project keys.
  app.use('/v1/projects', requireAuth, gatewayKeysRouter); // POST|GET /:id/api-keys, POST /:id/api-keys/:keyId/revoke

  // Onboarding: user context + admin. /v1/admin is platform-admin only;
  // /v1/customers enforces per-customer roles in members.ts.
  app.use('/v1/admin', requireAuth, requirePlatformAdmin, adminRouter);
  app.use('/v1/customers', requireAuth, membersRouter);
  app.use('/v1', requireAuth, billingRouter);   // /v1/billing/plans
  // 🐞 TE-04 fix: the per-customer billing routes (/:id/billing*) only ever
  // resolved as /v1/:id/billing — the console calls /v1/customers/:id/billing/*
  // (and validate.test.ts mounts the router this way), so the billing page
  // 404'd live. Mount the same router under /v1/customers as intended.
  app.use('/v1/customers', requireAuth, billingRouter); // /v1/customers/:id/billing/*
  app.use('/v1', requireAuth, meRouter);        // /v1/me
  // SE-10: invite accept-link — info is public (token is the capability),
  // redeem enforces requireAuth inside the router.
  app.use('/v1/invites', invitesRouter);

  // BE-05: consistent, safe errors. JSON 404 for unmatched routes, then the
  // terminal error middleware (must be last — Express calls 4-arg handlers
  // for anything passed to next(err), including asyncHandler rejections).
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
