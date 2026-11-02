// CD-02: control-plane API documentation — OpenAPI spec + human reference.
//
// Until CD-02 the only API "documentation" was the endpoint tables in
// backend/README.md. That is enough for a human reading the repo, but not
// for a developer automating against the service: there was no
// machine-readable contract to generate a client from, and nothing checked
// that the tables stayed in sync with the routers.
//
// This module is that contract. `buildControlPlaneOpenApi()` returns a
// dependency-free OpenAPI 3.1 document for every control-plane (and
// gateway-key data-plane) operation, each with request and success-response
// examples. It is served publicly at GET /v1/openapi.json (the document
// contains no secrets — credential examples are placeholders only), and
// GET /v1/docs renders the same document as a plain HTML reference.
// The test suite parses backend/README.md and asserts every tabled
// endpoint appears here with examples, so docs drift fails CI-style
// (`npm test`) instead of reaching a customer.
//
// Scope note: this documents the HTTP surface; it does not validate live
// behavior. Request schemas mirror src/validate.ts (zod) by hand — the
// zod schemas remain the runtime source of truth.

import { Router } from 'express';

export const API_DOCS_VERSION = '0.1.0';

type JsonObject = Record<string, unknown>;

const ERR_EXAMPLE = { error: 'Project not found', code: 'not_found', request_id: '00000000-0000-4000-8000-000000000001' };
const VALIDATION_EXAMPLE = { error: 'invalid_request', code: 'invalid_request', fields: { name: 'name is required' } };

function errResponse(description: string, example: unknown = ERR_EXAMPLE): JsonObject {
  return {
    description,
    content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }, example } },
  };
}

function jsonResponse(description: string, example: unknown, schema?: JsonObject): JsonObject {
  return {
    description,
    content: {
      'application/json': {
        schema: schema ?? { type: 'object', additionalProperties: true },
        example,
      },
    },
  };
}

function pathParam(name: string, description: string): JsonObject {
  return { name, in: 'path', required: true, description, schema: { type: 'string' } };
}

function queryParam(name: string, description: string, schema: JsonObject = { type: 'string' }): JsonObject {
  return { name, in: 'query', required: false, description, schema };
}

const LIMIT_PARAM = queryParam('limit', 'Page size (default 50, max 100). Keyset pagination (BE-08).', { type: 'integer', minimum: 1, maximum: 100 });
const CURSOR_PARAM = queryParam('cursor', 'Opaque keyset cursor from a previous response `pagination.next_cursor`.');

interface OpInput {
  operationId: string;
  summary: string;
  description?: string;
  tags: string[];
  /** Omit to inherit the global BearerAuth requirement. `[]` = public. */
  security?: unknown[];
  parameters?: JsonObject[];
  requestSchema?: JsonObject;
  requestExample?: unknown;
  successStatus?: number;
  successDescription: string;
  successExample: unknown;
  successSchema?: JsonObject;
  errorStatuses?: number[];
}

const ERROR_DESCRIPTIONS: Record<number, string> = {
  400: 'Malformed or invalid request body / query (field-level `fields` on validation failures).',
  401: 'Missing, expired, or invalid credential.',
  403: 'Authenticated, but role, workspace state, or policy forbids this action.',
  404: 'Resource not found (out-of-scope resources also 404 — no existence leak).',
  409: 'Conflict with current state (e.g. already subscribed, duplicate name).',
  422: 'Well-formed but not promotable / not actionable in current state.',
  429: 'Rate limited — retry after the `Retry-After` interval.',
  502: 'Upstream or storage dependency failed.',
  503: 'Feature not configured in this environment (e.g. Stripe, S3, credential vault).',
};

function operation(input: OpInput): JsonObject {
  const op: JsonObject = {
    operationId: input.operationId,
    summary: input.summary,
    tags: input.tags,
    responses: {},
  };
  if (input.description) op.description = input.description;
  if (input.security !== undefined) op.security = input.security;
  if (input.parameters?.length) op.parameters = input.parameters;
  if (input.requestExample !== undefined || input.requestSchema) {
    op.requestBody = {
      required: true,
      content: {
        'application/json': {
          schema: input.requestSchema ?? { type: 'object', additionalProperties: true },
          ...(input.requestExample !== undefined ? { example: input.requestExample } : {}),
        },
      },
    };
  }
  const responses: Record<string, JsonObject> = {};
  responses[String(input.successStatus ?? 200)] = jsonResponse(input.successDescription, input.successExample, input.successSchema);
  for (const status of input.errorStatuses ?? [400, 401, 403, 404]) {
    responses[String(status)] = errResponse(
      ERROR_DESCRIPTIONS[status] ?? 'Request failed.',
      status === 400 ? VALIDATION_EXAMPLE : ERR_EXAMPLE,
    );
  }
  op.responses = responses;
  return op;
}

const HUMAN: unknown[] | undefined = undefined; // inherit global BearerAuth
const PUBLIC: unknown[] = [];
const GATEWAY_OR_HUMAN: unknown[] = [{ BearerAuth: [] }, { GatewayKey: [] }, { GatewayBearer: [] }];

const ID = (label: string) => pathParam('id', `${label} id.`);

function buildComponents(): JsonObject {
  return {
    securitySchemes: {
      BearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'Cognito access JWT (shared user pool, us-east-1). Locally, CF_DEV_AUTH=true signs requests in as the seeded dev user.',
      },
      GatewayKey: {
        type: 'apiKey',
        in: 'header',
        name: 'X-API-Key',
        description: 'Project gateway key (cf_live_…) for data-plane calls. The same secret is also accepted as Authorization: Bearer cf_live_… (DP-07).',
      },
      GatewayBearer: {
        type: 'http',
        scheme: 'bearer',
        description: 'Project gateway key sent as a Bearer token (cf_live_…). Alternative to the X-API-Key header (DP-07).',
      },
    },
    schemas: {
      Error: {
        type: 'object',
        required: ['error', 'code', 'request_id'],
        properties: {
          error: { type: 'string', description: 'Human-readable, client-safe message.' },
          code: { type: 'string', description: 'Stable machine-readable error code.' },
          request_id: { type: 'string', description: 'Correlation id; also returned as the X-Request-Id header.' },
          fields: {
            type: 'object',
            additionalProperties: { type: 'string' },
            description: 'On 400 validation failures: field path → message (BE-04).',
          },
        },
      },
      Pagination: {
        type: 'object',
        properties: {
          limit: { type: 'integer' },
          has_more: { type: 'boolean' },
          next_cursor: { type: ['string', 'null'] },
        },
      },
    },
  };
}

function buildPathsA(): Record<string, Record<string, JsonObject>> {
  return {
    '/health': {
      get: operation({
        operationId: 'getHealth', summary: 'Liveness probe', tags: ['Health'], security: PUBLIC,
        successDescription: 'Service is up.', successExample: { ok: true, service: 'connector-foundry-server', version: '0.1.0' },
        errorStatuses: [],
      }),
    },
    '/v1/openapi.json': {
      get: operation({
        operationId: 'getOpenApiDocument', summary: 'This OpenAPI document', tags: ['API docs'], security: PUBLIC,
        description: 'Machine-readable control-plane contract (CD-02). Safe to fetch without credentials; contains no secrets.',
        successDescription: 'The OpenAPI 3.1 document.', successExample: { openapi: '3.1.0', info: { title: 'Connector Foundry API', version: '0.1.0' }, paths: {} },
        errorStatuses: [],
      }),
    },
    '/v1/docs': {
      get: operation({
        operationId: 'getApiReference', summary: 'Human-readable API reference (HTML)', tags: ['API docs'], security: PUBLIC,
        successDescription: 'Plain HTML operation index rendered from the OpenAPI document.', successExample: '(HTML page — see GET /v1/openapi.json for the machine-readable form.)',
        errorStatuses: [],
      }),
    },
    '/v1/me': {
      get: operation({
        operationId: 'getMe', summary: 'Current user and workspace memberships', tags: ['Identity'], security: HUMAN,
        successDescription: 'Caller identity plus every workspace membership with role and writability.',
        successExample: {
          user: { id: 'user-1', email: 'owner@example.com', full_name: 'Owner One', is_platform_admin: false },
          memberships: [{
            customer_id: 'cust-1', customer_name: 'Acme', customer_status: 'active', plan_id: 'starter',
            plan_name: 'Starter', role: 'owner', membership_status: 'active', writable: true, project_cap: 5, trial_ends_at: null,
          }],
        },
        errorStatuses: [401],
      }),
    },
    '/v1/me/organization': {
      post: operation({
        operationId: 'createOrganization', summary: 'Create my organization (self-serve signup step)', tags: ['Identity'], security: HUMAN,
        description: 'Creates a trial-plan customer with the caller as active owner (FE-07). No sample project is created (D-87). A non-admin who already holds an active membership gets 409.',
        requestSchema: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
        requestExample: { name: 'Acme Inc' },
        successStatus: 201, successDescription: 'Organization created; caller is its owner.',
        successExample: { customer: { id: 'cust-1', name: 'Acme Inc', plan_id: 'trial', status: 'trialing' } },
        errorStatuses: [400, 401, 409],
      }),
    },
    '/v1/admin/plans': {
      get: operation({
        operationId: 'listPlans', summary: 'List packaging plans (platform admin)', tags: ['Admin'], security: HUMAN,
        successDescription: 'All plans with caps.', successExample: { plans: [{ id: 'starter', name: 'Starter', seat_cap: 3, project_cap: 5, telemetry_retention_days: 90 }] },
        errorStatuses: [401, 403],
      }),
    },
    '/v1/admin/customers': {
      get: operation({
        operationId: 'listCustomers', summary: 'List customers with live usage (platform admin)', tags: ['Admin'], security: HUMAN,
        successDescription: 'Customers with seat/project usage.', successExample: { customers: [{ id: 'cust-1', name: 'Acme', status: 'active', seats_used: 2, projects_used: 1 }] },
        errorStatuses: [401, 403],
      }),
      post: operation({
        operationId: 'createCustomer', summary: 'Onboard a customer (platform admin)', tags: ['Admin'], security: HUMAN,
        requestSchema: {
          type: 'object', required: ['name'],
          properties: { name: { type: 'string' }, plan_id: { type: 'string' }, owner_email: { type: 'string', format: 'email' }, owner_name: { type: 'string' } },
        },
        requestExample: { name: 'Acme Inc', plan_id: 'trial', owner_email: 'owner@example.com' },
        successStatus: 201, successDescription: 'Customer onboarded (trial clock starts when applicable).',
        successExample: { customer: { id: 'cust-1', name: 'Acme Inc', status: 'trialing' } },
        errorStatuses: [400, 401, 403],
      }),
    },
    '/v1/admin/customers/{id}': {
      get: operation({
        operationId: 'getCustomer', summary: 'Customer detail + members (platform admin)', tags: ['Admin'], security: HUMAN,
        parameters: [ID('Customer')], successDescription: 'Customer with its member roster.',
        successExample: { customer: { id: 'cust-1', name: 'Acme', status: 'active' }, members: [{ user_id: 'user-1', role: 'owner', status: 'active' }] },
        errorStatuses: [401, 403, 404],
      }),
      patch: operation({
        operationId: 'updateCustomer', summary: 'Rename / re-plan / set status (platform admin)', tags: ['Admin'], security: HUMAN,
        parameters: [ID('Customer')],
        requestSchema: { type: 'object', properties: { name: { type: 'string' }, plan_id: { type: 'string' }, status: { type: 'string', enum: ['trialing', 'active', 'trial_expired', 'past_due', 'restricted', 'suspended'] } } },
        requestExample: { plan_id: 'growth' },
        successDescription: 'Updated customer summary.', successExample: { customer: { id: 'cust-1', plan_id: 'growth' } },
        errorStatuses: [400, 401, 403, 404],
      }),
    },
    '/v1/admin/customers/{id}/seats': {
      patch: operation({
        operationId: 'adjustCustomerSeats', summary: 'Set per-customer seat override (platform admin, staff-direct)', tags: ['Admin'], security: HUMAN,
        description: 'BL-05: `seats` is the total seat count (not an add-on); `null` restores the plan cap. Below-usage values evict nobody — invites block until under cap.',
        parameters: [ID('Customer')],
        requestSchema: { type: 'object', required: ['seats'], properties: { seats: { type: ['integer', 'null'], minimum: 1 }, reason: { type: 'string' } } },
        requestExample: { seats: 15, reason: 'Pilot expansion' },
        successDescription: 'Customer summary with the effective cap.', successExample: { customer: { id: 'cust-1', seat_override: 15 } },
        errorStatuses: [400, 401, 403, 404],
      }),
    },
    '/v1/admin/customers/{id}/suspend': {
      post: operation({
        operationId: 'suspendCustomer', summary: 'Suspend a customer (platform admin)', tags: ['Admin'], security: HUMAN,
        parameters: [ID('Customer')], successDescription: 'Customer suspended.', successExample: { customer: { id: 'cust-1', status: 'suspended' } },
        errorStatuses: [401, 403, 404],
      }),
    },
    '/v1/admin/customers/{id}/reactivate': {
      post: operation({
        operationId: 'reactivateCustomer', summary: 'Reactivate a customer (platform admin)', tags: ['Admin'], security: HUMAN,
        parameters: [ID('Customer')], successDescription: 'Customer reactivated (dunning clock cleared).', successExample: { customer: { id: 'cust-1', status: 'active' } },
        errorStatuses: [401, 403, 404],
      }),
    },
    '/v1/admin/users': {
      get: operation({
        operationId: 'listUsers', summary: 'Human roster (platform admin)', tags: ['Admin'], security: HUMAN,
        successDescription: 'All users.', successExample: { users: [{ id: 'user-1', email: 'owner@example.com', is_platform_admin: false, status: 'active' }] },
        errorStatuses: [401, 403],
      }),
    },
    '/v1/admin/users/{id}': {
      patch: operation({
        operationId: 'updateUser', summary: 'Set platform-admin flag / status (platform admin)', tags: ['Admin'], security: HUMAN,
        parameters: [ID('User')],
        requestSchema: { type: 'object', properties: { is_platform_admin: { type: 'boolean' }, status: { type: 'string', enum: ['active', 'suspended'] } } },
        requestExample: { is_platform_admin: true },
        successDescription: 'Updated user.', successExample: { user: { id: 'user-1', is_platform_admin: true } },
        errorStatuses: [400, 401, 403, 404],
      }),
    },
    '/v1/customers/{id}/users': {
      get: operation({
        operationId: 'listMembers', summary: 'Workspace roster + seat usage', tags: ['Team'], security: HUMAN,
        parameters: [ID('Customer')], successDescription: 'Members with usage (N of M seats).',
        successExample: { members: [{ user_id: 'user-1', email: 'owner@example.com', role: 'owner', status: 'active' }], usage: { seats_used: 1, seats_cap: 3 } },
        errorStatuses: [401, 403, 404],
      }),
    },
    '/v1/customers/{id}/usage': {
      get: operation({
        operationId: 'getWorkspaceUsage', summary: 'Workspace usage counters', tags: ['Team'], security: HUMAN,
        parameters: [ID('Customer')], successDescription: 'Seat/project usage against plan caps.',
        successExample: { usage: { seats_used: 1, seats_cap: 3, projects_used: 1, projects_cap: 5 } },
        errorStatuses: [401, 403, 404],
      }),
    },
    '/v1/customers/{id}/users/invite': {
      post: operation({
        operationId: 'inviteMember', summary: 'Invite a teammate by email (owner)', tags: ['Team'], security: HUMAN,
        description: 'Seat-cap enforced (409 with upgrade nudge at cap). Acceptance is token redemption (SE-10) with first-sign-in fallback for legacy invites.',
        parameters: [ID('Customer')],
        requestSchema: { type: 'object', required: ['email'], properties: { email: { type: 'string', format: 'email' }, role: { type: 'string', enum: ['owner', 'editor', 'viewer'] }, full_name: { type: 'string' } } },
        requestExample: { email: 'teammate@example.com', role: 'editor' },
        successStatus: 201, successDescription: 'Pending membership created (seat reserved).',
        successExample: { member: { user_id: 'user-2', email: 'teammate@example.com', role: 'editor', status: 'invited' } },
        errorStatuses: [400, 401, 403, 404, 409],
      }),
    },
    '/v1/customers/{id}/users/{userId}': {
      patch: operation({
        operationId: 'updateMember', summary: 'Change role / suspend member (owner)', tags: ['Team'], security: HUMAN,
        parameters: [ID('Customer'), pathParam('userId', 'Member user id.')],
        requestSchema: { type: 'object', properties: { role: { type: 'string', enum: ['owner', 'editor', 'viewer'] }, status: { type: 'string', enum: ['active', 'suspended'] } } },
        requestExample: { role: 'viewer' },
        successDescription: 'Updated membership (takes effect on next request).', successExample: { member: { user_id: 'user-2', role: 'viewer', status: 'active' } },
        errorStatuses: [400, 401, 403, 404, 409],
      }),
      delete: operation({
        operationId: 'removeMember', summary: 'Remove a member (owner; last owner protected)', tags: ['Team'], security: HUMAN,
        parameters: [ID('Customer'), pathParam('userId', 'Member user id.')],
        successDescription: 'Membership removed.', successExample: { ok: true },
        errorStatuses: [401, 403, 404, 409],
      }),
    },
    '/v1/billing/plans': {
      get: operation({
        operationId: 'listBillingPlans', summary: 'Purchasable packages', tags: ['Billing'], security: HUMAN,
        description: 'Starter is the free tier during early access; Growth/Scale are early-access only until the first free customer lands (D-33).',
        successDescription: 'Plans with caps and display prices.', successExample: { plans: [{ id: 'starter', name: 'Starter', price_display: 'Free during early access' }] },
        errorStatuses: [401],
      }),
    },
    '/v1/customers/{id}/billing': {
      get: operation({
        operationId: 'getBilling', summary: 'Current package, status, and trial state', tags: ['Billing'], security: HUMAN,
        parameters: [ID('Customer')], successDescription: 'Billing summary including dunning fields.',
        successExample: { billing: { plan_id: 'starter', status: 'active', trial_ends_at: null } },
        errorStatuses: [401, 403, 404],
      }),
    },
    '/v1/customers/{id}/billing/checkout': {
      post: operation({
        operationId: 'createCheckout', summary: 'Start Stripe Checkout (owner)', tags: ['Billing'], security: HUMAN,
        description: 'Returns the Stripe-hosted checkout URL. 503 until Stripe is configured; 409 when already subscribed (use the portal). Stripe is parked until Naveen says go — this documents the shipped surface.',
        parameters: [ID('Customer')],
        requestSchema: { type: 'object', required: ['plan_id'], properties: { plan_id: { type: 'string' } } },
        requestExample: { plan_id: 'growth' },
        successDescription: 'Checkout session URL.', successExample: { url: 'https://checkout.stripe.com/c/pay/example' },
        errorStatuses: [400, 401, 403, 404, 409, 503],
      }),
    },
    '/v1/customers/{id}/billing/portal': {
      post: operation({
        operationId: 'createPortal', summary: 'Open Stripe Customer Portal (owner)', tags: ['Billing'], security: HUMAN,
        parameters: [ID('Customer')], successDescription: 'Portal URL for upgrade/downgrade/cancel.',
        successExample: { url: 'https://billing.stripe.com/p/session/example' },
        errorStatuses: [401, 403, 404, 503],
      }),
    },
    '/v1/customers/{id}/billing/invoices': {
      get: operation({
        operationId: 'listInvoices', summary: 'Last 12 invoices with receipt links', tags: ['Billing'], security: HUMAN,
        parameters: [ID('Customer')], successDescription: 'Invoice history.',
        successExample: { invoices: [{ id: 'in_example', total: 0, hosted_invoice_url: 'https://invoice.stripe.com/example' }] },
        errorStatuses: [401, 403, 404, 503],
      }),
    },
    '/v1/customers/{id}/billing/usage': {
      get: operation({
        operationId: 'getUsage', summary: 'Metered invocations per project (TE-04)', tags: ['Billing'], security: HUMAN,
        parameters: [ID('Customer'), queryParam('from', 'Window start (ISO date, UTC month default).'), queryParam('to', 'Window end (exclusive).')],
        successDescription: 'Usage aggregated from telemetry_events (single source of truth).',
        successExample: { usage: { from: '2026-10-01T00:00:00.000Z', to: '2026-11-01T00:00:00.000Z', projects: [{ project_id: 'proj-1', invocations: 42 }] } },
        errorStatuses: [400, 401, 403, 404],
      }),
    },
    '/v1/customers/{id}/billing/usage/reconciliation': {
      get: operation({
        operationId: 'reconcileUsage', summary: 'Metered usage vs a Stripe invoice (TE-04)', tags: ['Billing'], security: HUMAN,
        parameters: [ID('Customer'), queryParam('invoice_id', 'Stripe invoice id to reconcile against.')],
        successDescription: 'Discrepancy list — never a silent pass.',
        successExample: { reconciliation: { invoice_id: 'in_example', discrepancies: [] } },
        errorStatuses: [400, 401, 403, 404, 503],
      }),
    },
    '/v1/billing/webhook': {
      post: operation({
        operationId: 'stripeWebhook', summary: 'Stripe webhook receiver (public, signature-verified)', tags: ['Billing'], security: PUBLIC,
        description: 'Raw-body endpoint; the Stripe-Signature header is verified before any state change. Idempotent via billing_events.',
        requestExample: { id: 'evt_example', type: 'checkout.session.completed', data: { object: {} } },
        successDescription: 'Event accepted.', successExample: { received: true },
        errorStatuses: [400, 503],
      }),
    },
  };
}

function buildPathsB(): Record<string, Record<string, JsonObject>> {
  const projectId = ID('Project');
  const releaseId = pathParam('releaseId', 'Release id.');
  return {
    '/v1/projects': {
      get: operation({
        operationId: 'listProjects', summary: 'List projects', tags: ['Projects'], security: HUMAN,
        parameters: [LIMIT_PARAM, CURSOR_PARAM],
        successDescription: 'Projects visible to the caller (tenant-scoped).',
        successExample: { projects: [{ id: 'proj-1', name: 'Weather API', customer_id: 'cust-1' }], pagination: { limit: 50, has_more: false, next_cursor: null } },
        errorStatuses: [400, 401],
      }),
      post: operation({
        operationId: 'createProject', summary: 'Create a project', tags: ['Projects'], security: HUMAN,
        requestSchema: {
          type: 'object', required: ['name'],
          properties: { name: { type: 'string' }, description: { type: 'string' }, targets: { type: 'array', items: { type: 'string' } }, customer_id: { type: 'string' } },
        },
        requestExample: { name: 'Weather API', description: 'Forecast integration', targets: ['mcp', 'openai', 'muse'] },
        successStatus: 201, successDescription: 'Project created (plan cap enforced).',
        successExample: { project: { id: 'proj-1', name: 'Weather API', status: 'active' } },
        errorStatuses: [400, 401, 403, 409],
      }),
    },
    '/v1/projects/{id}': {
      get: operation({
        operationId: 'getProject', summary: 'Project detail', tags: ['Projects'], security: HUMAN,
        parameters: [projectId], successDescription: 'One project (outsiders 404).',
        successExample: { project: { id: 'proj-1', name: 'Weather API' } },
        errorStatuses: [401, 404],
      }),
      patch: operation({
        operationId: 'updateProject', summary: 'Rename / retarget a project (owner/editor)', tags: ['Projects'], security: HUMAN,
        parameters: [projectId],
        requestSchema: { type: 'object', properties: { name: { type: 'string' }, description: { type: ['string', 'null'] }, targets: { type: 'array', items: { type: 'string' } } } },
        requestExample: { name: 'Weather API v2' },
        successDescription: 'Updated project.', successExample: { project: { id: 'proj-1', name: 'Weather API v2' } },
        errorStatuses: [400, 401, 403, 404],
      }),
      delete: operation({
        operationId: 'deleteProject', summary: 'Permanently delete a project (owner only, SE-04)', tags: ['Projects'], security: HUMAN,
        description: 'Hard delete in one transaction; an audit tombstone (counts only, no content) survives.',
        parameters: [projectId], successDescription: 'Deletion counts by table.',
        successExample: { ok: true, project_id: 'proj-1', deleted: { tools: 3, telemetry_events: 120 } },
        errorStatuses: [401, 403, 404],
      }),
    },
    '/v1/projects/{id}/export': {
      get: operation({
        operationId: 'exportProject', summary: 'Download everything held for a project (SE-04)', tags: ['Projects'], security: HUMAN,
        parameters: [projectId], successDescription: 'One JSON attachment: specs, tools, review, eval, releases, jobs, telemetry.',
        successExample: { project: { id: 'proj-1' }, tools: [], releases: [] },
        errorStatuses: [401, 404],
      }),
    },
    '/v1/projects/{id}/sources': {
      post: operation({
        operationId: 'importSource', summary: 'Import an API spec snapshot (owner/editor)', tags: ['Sources'], security: HUMAN,
        description: 'Accepts OpenAPI 3.x, Swagger 2.0 (IA-01), and Postman Collection v2.1 (IA-02). Broken $refs fail with 400 spec_validation_error and per-issue pointers (IA-04); nothing is stored on failure.',
        parameters: [projectId],
        requestSchema: {
          type: 'object', required: ['type', 'payload'],
          properties: { type: { type: 'string', enum: ['openapi_url', 'openapi_json', 'openapi_text', 'postman_url', 'postman_json', 'postman_text'] }, payload: {} },
        },
        requestExample: { type: 'openapi_json', payload: { openapi: '3.1.0', info: { title: 'Weather', version: '1.0.0' }, paths: {} } },
        successStatus: 201, successDescription: 'Snapshot persisted; operations parsed.',
        successExample: { source: { id: 'src-1', source_type: 'openapi' }, operations: 3, findings: 1 },
        errorStatuses: [400, 401, 403, 404],
      }),
      get: operation({
        operationId: 'listSources', summary: 'Imported sources', tags: ['Sources'], security: HUMAN,
        parameters: [projectId], successDescription: 'Source snapshots (byte-identical to upload).',
        successExample: { sources: [{ id: 'src-1', source_type: 'openapi', created_at: '2026-10-01T00:00:00.000Z' }] },
        errorStatuses: [401, 404],
      }),
    },
    '/v1/projects/{id}/operations': {
      get: operation({
        operationId: 'listOperations', summary: 'Parsed operation inventory', tags: ['Sources'], security: HUMAN,
        parameters: [projectId], successDescription: 'Operations extracted from the latest spec.',
        successExample: { operations: [{ method: 'GET', path: '/forecast', operation_id: 'getForecast' }] },
        errorStatuses: [401, 404],
      }),
    },
    '/v1/projects/{id}/review': {
      get: operation({
        operationId: 'listReviewItems', summary: 'Review queue (blockers / ambiguities)', tags: ['Sources'], security: HUMAN,
        parameters: [projectId], successDescription: 'Findings awaiting propose → review → approve.',
        successExample: { review_items: [{ id: 'rev-1', kind: 'missing_description', status: 'open' }] },
        errorStatuses: [401, 404],
      }),
    },
    '/v1/projects/review/{itemId}': {
      patch: operation({
        operationId: 'resolveReviewItem', summary: 'Resolve or dismiss a review item (owner/editor)', tags: ['Sources'], security: HUMAN,
        parameters: [pathParam('itemId', 'Review item id.')],
        requestSchema: { type: 'object', required: ['status'], properties: { status: { type: 'string', enum: ['resolved', 'dismissed'] } } },
        requestExample: { status: 'resolved' },
        successDescription: 'Item closed.', successExample: { ok: true },
        errorStatuses: [400, 401, 403, 404],
      }),
    },
    '/v1/projects/{id}/compile': {
      post: operation({
        operationId: 'compileProject', summary: 'Compile operations into tool drafts (async, 202)', tags: ['Tools'], security: HUMAN,
        description: 'Enqueues a compile job (deduped per project); poll GET /v1/projects/{id}/jobs. Request bodies/headers/cookies are frozen into the tool snapshot (BE-16/BE-17).',
        parameters: [projectId], successStatus: 202, successDescription: 'Compile job queued (or the in-flight job returned).',
        successExample: { job: { id: 'job-1', kind: 'compile', status: 'queued' }, deduplicated: false },
        errorStatuses: [401, 403, 404],
      }),
    },
    '/v1/projects/{id}/tools': {
      get: operation({
        operationId: 'listTools', summary: 'Tools + recovery rules', tags: ['Tools'], security: HUMAN,
        parameters: [projectId, LIMIT_PARAM, CURSOR_PARAM], successDescription: 'Canonical tools (alphabetical keyset).',
        successExample: { tools: [{ id: 'tool-1', name: 'getForecast', status: 'approved', version: 2 }], pagination: { limit: 50, has_more: false, next_cursor: null } },
        errorStatuses: [400, 401, 404],
      }),
    },
    '/v1/projects/tools/{toolId}': {
      patch: operation({
        operationId: 'updateTool', summary: 'Edit a tool; status approved approves it (owner/editor)', tags: ['Tools'], security: HUMAN,
        description: 'Approval bumps the tool version and carries recovery rules forward (BE-00).',
        parameters: [pathParam('toolId', 'Tool id.')],
        requestSchema: {
          type: 'object',
          properties: {
            name: { type: 'string' }, description: { type: ['string', 'null'] }, purpose: { type: ['string', 'null'] },
            status: { type: 'string', enum: ['candidate', 'approved', 'tested'] },
          },
        },
        requestExample: { status: 'approved' },
        successDescription: 'Updated tool (approved tools carry a new version).', successExample: { tool: { id: 'tool-1', status: 'approved', version: 2 } },
        errorStatuses: [400, 401, 403, 404],
      }),
    },
    '/v1/projects/{id}/eval': {
      post: operation({
        operationId: 'runEvaluation', summary: 'Run evaluation suites (async, 202)', tags: ['Evaluation'], security: HUMAN,
        description: 'Enqueues an eval job against the live upstream. Credentialed tools are evaluated with the real stored key (EV-01); the run ends with an EV-05 certification verdict.',
        parameters: [projectId], successStatus: 202, successDescription: 'Eval job queued.',
        successExample: { job: { id: 'job-2', kind: 'eval', status: 'queued' }, deduplicated: false },
        errorStatuses: [401, 403, 404],
      }),
    },
    '/v1/projects/{id}/jobs': {
      get: operation({
        operationId: 'listJobs', summary: 'Compile/eval job history', tags: ['Jobs'], security: HUMAN,
        parameters: [projectId, LIMIT_PARAM, CURSOR_PARAM], successDescription: 'Jobs with progress.',
        successExample: { jobs: [{ id: 'job-1', kind: 'compile', status: 'succeeded' }], pagination: { limit: 50, has_more: false, next_cursor: null } },
        errorStatuses: [400, 401, 404],
      }),
    },
    '/v1/jobs/{jobId}': {
      get: operation({
        operationId: 'getJob', summary: 'One job (status + per-tool progress)', tags: ['Jobs'], security: HUMAN,
        parameters: [pathParam('jobId', 'Job id.')], successDescription: 'Job detail.',
        successExample: { job: { id: 'job-1', kind: 'eval', status: 'running', progress: { done: 2, total: 3 } } },
        errorStatuses: [401, 404],
      }),
    },
    '/v1/projects/{id}/eval/runs': {
      get: operation({
        operationId: 'listEvalRuns', summary: 'Eval run history', tags: ['Evaluation'], security: HUMAN,
        parameters: [projectId, LIMIT_PARAM, CURSOR_PARAM], successDescription: 'Runs newest-first with suite summaries and certification verdicts.',
        successExample: { runs: [{ id: 'run-1', status: 'passed', certification: { certified: true, criteria_version: 'v2' } }], pagination: { limit: 50, has_more: false, next_cursor: null } },
        errorStatuses: [400, 401, 404],
      }),
    },
    '/v1/eval/runs/{runId}': {
      get: operation({
        operationId: 'getEvalRun', summary: 'One eval run + scenario results', tags: ['Evaluation'], security: HUMAN,
        parameters: [pathParam('runId', 'Eval run id.')], successDescription: 'Run with per-scenario results (evidence URLs never carry credentials).',
        successExample: { run: { id: 'run-1', status: 'passed' }, results: [{ tool_id: 'tool-1', suite: 'contract', passed: true }] },
        errorStatuses: [401, 404],
      }),
    },
    '/v1/projects/{id}/eval/runs/{runId}/report': {
      get: operation({
        operationId: 'downloadEvalReport', summary: 'Downloadable eval report (EV-03)', tags: ['Evaluation'], security: HUMAN,
        description: 'Renders a self-contained HTML report. With report storage configured the HTML goes to S3 and the answer is a short-lived signed URL; without it the HTML is answered inline for direct download.',
        parameters: [projectId, pathParam('runId', 'Eval run id.')],
        successDescription: 'Signed report URL, or the inline HTML.', successExample: { report: { url: 'https://example-bucket.s3.amazonaws.com/eval-reports/run-1.html?signature=example', expires_at: '2026-10-04T21:00:00.000Z', format: 'html', size_bytes: 12345 } },
        errorStatuses: [401, 404, 502],
      }),
    },
    '/v1/projects/{id}/tools/{toolId}/eval-scenarios': {
      get: operation({
        operationId: 'listEvalScenarios', summary: 'Custom eval scenarios for a tool (EV-04)', tags: ['Evaluation'], security: HUMAN,
        description: 'Enabled scenarios run inside every evaluation (suite custom) and gate release. Names are unique per tool.',
        parameters: [projectId, pathParam('toolId', 'Tool id.')], successDescription: 'Scenarios oldest-first.',
        successExample: { scenarios: [{ id: 'scen-1', tool_id: 'tool-1', name: 'Required args happy path', given_args: { orderId: 'ord_123' }, expect_status: 200, expect_body_keys: ['status'], enabled: true }] },
        errorStatuses: [401, 404],
      }),
      post: operation({
        operationId: 'createEvalScenario', summary: 'Add a custom eval scenario (owner/editor, EV-04)', tags: ['Evaluation'], security: HUMAN,
        description: 'Given args → expect shape/status. An unset expect_status expects 2xx; an empty expect_body_keys asserts no shape. Duplicate name per tool → 409 scenario_name_conflict.',
        parameters: [projectId, pathParam('toolId', 'Tool id.')],
        requestSchema: {
          type: 'object', required: ['name'],
          properties: {
            name: { type: 'string', maxLength: 120 },
            given_args: { type: 'object', additionalProperties: true },
            expect_status: { type: ['integer', 'null'], minimum: 100, maximum: 599 },
            expect_body_keys: { type: 'array', items: { type: 'string' }, maxItems: 50 },
            enabled: { type: 'boolean' },
          },
        },
        requestExample: { name: 'Required args happy path', given_args: { orderId: 'ord_123' }, expect_status: 200, expect_body_keys: ['status'] },
        successStatus: 201, successDescription: 'Scenario stored; it runs from the next evaluation.',
        successExample: { scenario: { id: 'scen-1', tool_id: 'tool-1', name: 'Required args happy path', expect_status: 200, enabled: true } },
        errorStatuses: [400, 401, 403, 404, 409],
      }),
    },
    '/v1/projects/{id}/tools/{toolId}/eval-scenarios/{scenarioId}': {
      patch: operation({
        operationId: 'updateEvalScenario', summary: 'Edit a custom eval scenario (owner/editor, EV-04)', tags: ['Evaluation'], security: HUMAN,
        parameters: [projectId, pathParam('toolId', 'Tool id.'), pathParam('scenarioId', 'Scenario id.')],
        requestSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', maxLength: 120 },
            given_args: { type: 'object', additionalProperties: true },
            expect_status: { type: ['integer', 'null'], minimum: 100, maximum: 599 },
            expect_body_keys: { type: 'array', items: { type: 'string' }, maxItems: 50 },
            enabled: { type: 'boolean' },
          },
        },
        requestExample: { enabled: false },
        successDescription: 'Updated scenario.', successExample: { scenario: { id: 'scen-1', enabled: false } },
        errorStatuses: [400, 401, 403, 404, 409],
      }),
      delete: operation({
        operationId: 'deleteEvalScenario', summary: 'Delete a custom eval scenario (owner/editor, EV-04)', tags: ['Evaluation'], security: HUMAN,
        parameters: [projectId, pathParam('toolId', 'Tool id.'), pathParam('scenarioId', 'Scenario id.')],
        successDescription: 'Scenario removed; past run results are kept.', successExample: { ok: true, scenario_id: 'scen-1' },
        errorStatuses: [401, 403, 404],
      }),
    },
    '/v1/projects/{id}/drift/alerts': {
      get: operation({
        operationId: 'listDriftAlerts', summary: 'Drift alerts for the prod release (TE-03)', tags: ['Evaluation'], security: HUMAN,
        description: 'Alerts opened when a scheduled drift check finds a contract probe failing against the prod release\'s frozen tools; auto-resolved by the next passing check. Keyset pagination (BE-08).',
        parameters: [projectId, LIMIT_PARAM, CURSOR_PARAM, queryParam('status', 'Filter: open (default), resolved, or all.')],
        successDescription: 'Alerts newest-first with failing scenarios and probe evidence.',
        successExample: { alerts: [{ id: 'da-1', tool_name: 'getForecast', status: 'open', evidence: { failed_scenarios: ['happy_path_2xx_json'] } }], pagination: { limit: 50, has_more: false, next_cursor: null }, caller_role: 'owner' },
        errorStatuses: [400, 401, 404],
      }),
    },
    '/v1/projects/{id}/drift/checks': {
      get: operation({
        operationId: 'listDriftChecks', summary: 'Drift check history (TE-03)', tags: ['Evaluation'], security: HUMAN,
        description: 'Scheduled (every CF_DRIFT_CHECK_INTERVAL_MS, default 30m) and manual contract-probe runs against the prod release. Keyset pagination (BE-08).',
        parameters: [projectId, LIMIT_PARAM, CURSOR_PARAM],
        successDescription: 'Checks newest-first with per-tool outcomes.',
        successExample: { checks: [{ id: 'dc-1', status: 'succeeded', trigger: 'schedule', summary: { tools_checked: 3, tools_passed: 3, tools_failed: [], tools_skipped: [] } }], pagination: { limit: 50, has_more: false, next_cursor: null } },
        errorStatuses: [400, 401, 404],
      }),
    },
    '/v1/projects/{id}/drift/check': {
      post: operation({
        operationId: 'triggerDriftCheck', summary: 'Run a drift check now (owner/editor, TE-03)', tags: ['Evaluation'], security: HUMAN,
        description: 'Enqueues a drift-check job (202) against the current prod release; dedups while one is queued/running. 409 drift_no_prod_release when nothing is in prod yet.',
        parameters: [projectId], successStatus: 202,
        successDescription: 'Drift check enqueued.', successExample: { job: { id: 'job-1', kind: 'drift', status: 'queued' }, deduplicated: false },
        errorStatuses: [401, 403, 404, 409],
      }),
    },
    '/v1/projects/{id}/releases': {
      post: operation({
        operationId: 'createRelease', summary: 'Freeze + sign a release (gated)', tags: ['Releases'], security: HUMAN,
        description: 'Gate: every tool approved and the latest eval run passed. Releases are born in the staging channel (RL-07).',
        parameters: [projectId],
        requestSchema: { type: 'object', required: ['version'], properties: { version: { type: 'string' } } },
        requestExample: { version: '1.0.0' },
        successStatus: 201, successDescription: 'Release frozen and HMAC-signed.',
        successExample: { release_id: 'rel-1', version: '1.0.0', manifest: { version: '1.0.0', tools: [] } },
        errorStatuses: [400, 401, 403, 404],
      }),
      get: operation({
        operationId: 'listReleases', summary: 'Release history', tags: ['Releases'], security: HUMAN,
        parameters: [projectId, LIMIT_PARAM, CURSOR_PARAM], successDescription: 'Releases with channel and deprecation state (signatures are never listed — SE-11).',
        successExample: { releases: [{ id: 'rel-1', version: '1.0.0', status: 'approved', channel: 'prod' }], pagination: { limit: 50, has_more: false, next_cursor: null } },
        errorStatuses: [400, 401, 404],
      }),
    },
    '/v1/releases/{releaseId}/approve': {
      post: operation({
        operationId: 'approveRelease', summary: 'Customer sign-off on a release', tags: ['Releases'], security: HUMAN,
        parameters: [releaseId],
        requestSchema: { type: 'object', properties: { approver: { type: 'string' } } },
        requestExample: { approver: 'owner@example.com' },
        successDescription: 'Release approved.', successExample: { ok: true },
        errorStatuses: [400, 401, 403, 404],
      }),
    },
    '/v1/releases/{releaseId}/promote': {
      post: operation({
        operationId: 'promoteRelease', summary: 'Promote staging → prod (certification-gated, RL-08)', tags: ['Releases'], security: HUMAN,
        description: 'Prod requires EV-05 certification of the latest completed run; gaps return 422 promotion_blocked with the checklist. Staging is ungated.',
        parameters: [releaseId],
        requestSchema: { type: 'object', properties: { channel: { type: 'string', enum: ['staging', 'prod'] } } },
        requestExample: { channel: 'prod' },
        successDescription: 'Release serving in the target channel.', successExample: { release_id: 'rel-1', channel: 'prod' },
        errorStatuses: [400, 401, 403, 404, 409, 422],
      }),
    },
    '/v1/releases/{releaseId}/promotion-readiness': {
      get: operation({
        operationId: 'getPromotionReadiness', summary: 'What is missing for prod promotion (RL-08)', tags: ['Releases'], security: HUMAN,
        parameters: [releaseId], successDescription: 'Checklist with per-item customer actions.',
        successExample: { ready: false, checks: [{ id: 'certified', status: 'fail', detail: 'Latest run is not certified.' }] },
        errorStatuses: [401, 404],
      }),
    },
    '/v1/releases/{releaseId}/rollback': {
      post: operation({
        operationId: 'rollbackRelease', summary: 'Deprecate a release (instant rollback, RL-06)', tags: ['Releases'], security: HUMAN,
        parameters: [releaseId],
        requestSchema: { type: 'object', properties: { reason: { type: 'string' } } },
        requestExample: { reason: 'Bad schema in 1.0.1' },
        successDescription: 'Release deprecated; invokes name the previous approved fallback.',
        successExample: { release_id: 'rel-1', status: 'deprecated' },
        errorStatuses: [400, 401, 403, 404, 409],
      }),
    },
    '/v1/releases/{releaseId}/manifest': {
      get: operation({
        operationId: 'downloadManifest', summary: 'Download the connector manifest', tags: ['Releases'], security: HUMAN,
        parameters: [releaseId], successDescription: 'Frozen, signed manifest (never contains credential material).',
        successExample: { version: '1.0.0', tools: [{ name: 'getForecast' }] },
        errorStatuses: [401, 404],
      }),
    },
    '/v1/releases/{releaseId}/mcp/stdio': {
      get: operation({
        operationId: 'downloadMcpStdioBridge', summary: 'Download the MCP stdio bridge artifact (RL-03)', tags: ['MCP'], security: HUMAN,
        description: 'Dependency-free Node bridge proxying to the hosted MCP endpoint. Reads its gateway key from CF_GATEWAY_KEY — the key is never embedded.',
        parameters: [releaseId], successDescription: 'Bridge metadata + download payload.',
        successExample: { release_id: 'rel-1', version: '1.0.0', tools: [] },
        errorStatuses: [401, 404],
      }),
    },
    '/v1/releases/{releaseId}/openai/tools': {
      get: operation({
        operationId: 'downloadOpenAiTools', summary: 'OpenAI function-calling tools array (RL-04)', tags: ['Releases'], security: HUMAN,
        description: 'Generated from the frozen snapshot and self-validated before serving (malformed ⇒ 500). Deprecated releases refuse with 409.',
        parameters: [releaseId], successDescription: 'Function-calling schemas for the release.',
        successExample: { release_id: 'rel-1', version: '1.0.0', tools: [{ type: 'function', function: { name: 'getForecast', parameters: { type: 'object' }, strict: false } }] },
        errorStatuses: [401, 404, 409],
      }),
    },
    '/v1/releases/{releaseId}/openai/actions': {
      get: operation({
        operationId: 'downloadOpenAiActions', summary: 'GPT Actions OpenAPI 3.1 document (RL-04)', tags: ['Releases'], security: HUMAN,
        parameters: [releaseId], successDescription: 'One operation per tool; x-openai-isConsequential reflects effect classes.',
        successExample: { openapi: '3.1.0', info: { title: 'Weather API actions', version: '1.0.0' }, paths: {} },
        errorStatuses: [401, 404, 409],
      }),
    },
    '/v1/releases/{releaseId}/muse/kit': {
      get: operation({
        operationId: 'downloadMuseKit', summary: 'Meta Muse submission kit (HK-08)', tags: ['Releases'], security: HUMAN,
        description: 'Existing-MCP endpoint plus per-tool Read/Write/Sensitive-write classes, auth requirements, the review gate (money-movement / destructive / unconfirmed writes block with a reason each) and a form checklist with prefilled values. Deprecated releases refuse with 409.',
        parameters: [releaseId], successDescription: 'Submission kit for the manual Muse intake form.',
        successExample: { connector: { name: 'Weather-connector', version: '1.0.0' }, connection: { type: 'existing_mcp' }, review_gate: { eligible: true, reasons: [] } },
        errorStatuses: [401, 404, 409],
      }),
    },
    '/v1/runtime/invoke': {
      post: operation({
        operationId: 'invokeTool', summary: 'Invoke a released tool (data plane)', tags: ['Runtime'], security: GATEWAY_OR_HUMAN,
        description: 'Signature-verified per call; credential injection, egress policy (SE-08), circuit breaker, and rate limits apply. Human callers pass the role gate; gateway-key callers are charged per-key buckets. version accepts a pinned version or the staging/prod alias.',
        requestSchema: {
          type: 'object', required: ['project_id', 'version', 'tool_name'],
          properties: {
            project_id: { type: 'string' }, version: { type: 'string' }, tool_name: { type: 'string' },
            args: { type: 'object', additionalProperties: true }, prompt_ref: { type: 'string' },
          },
        },
        requestExample: { project_id: 'proj-1', version: 'prod', tool_name: 'getForecast', args: { latitude: 52.52, longitude: 13.41 } },
        successDescription: 'Tool result (failures carry a machine-readable condition, never a bare 500).',
        successExample: { ok: true, tool: 'getForecast', release_version: '1.0.0', result: { temperature_2m: 21.5 }, latency_ms: 120 },
        errorStatuses: [400, 401, 403, 404, 429, 502],
      }),
    },
    '/v1/projects/{id}/telemetry': {
      get: operation({
        operationId: 'getTelemetry', summary: 'Invocation telemetry for Operate', tags: ['Runtime'], security: HUMAN,
        description: 'Windowed by the owning plan retention (TE-02): over-plan windows return 200 with retention.locked=true, never an error.',
        parameters: [projectId, queryParam('days', 'Window in days (clamped to plan retention).'), LIMIT_PARAM, CURSOR_PARAM],
        successDescription: 'Aggregates + recent redacted events (DP-05).',
        successExample: { summary: { invocations: 42, errors: 1 }, retention: { retention_days: 90, locked: false }, recent: [] },
        errorStatuses: [400, 401, 404],
      }),
    },
    '/v1/projects/{id}/credentials': {
      post: operation({
        operationId: 'captureCredential', summary: 'Attach an upstream API key (broker, AB-02)', tags: ['Credentials'], security: HUMAN,
        description: 'Value is KMS-envelope encrypted at capture and never returned. 503 credential_storage_not_configured until the vault exists.',
        parameters: [projectId],
        requestSchema: { type: 'object', required: ['label', 'value'], properties: { label: { type: 'string' }, value: { type: 'string', format: 'password' } } },
        requestExample: { label: 'Production key', value: 'example-api-key-value' },
        successStatus: 201, successDescription: 'Credential metadata (fingerprint only — never the value).',
        successExample: { id: 'cred-1', label: 'Production key', fingerprint: 'sha256:example', status: 'active' },
        errorStatuses: [400, 401, 403, 404, 503],
      }),
      get: operation({
        operationId: 'listCredentials', summary: 'Credential metadata (values never listed)', tags: ['Credentials'], security: HUMAN,
        parameters: [projectId], successDescription: 'Active/rotated/revoked credential metadata.',
        successExample: { credentials: [{ id: 'cred-1', label: 'Production key', status: 'active' }] },
        errorStatuses: [401, 404],
      }),
    },
    '/v1/projects/{id}/credentials/{credId}/rotate': {
      post: operation({
        operationId: 'rotateCredential', summary: 'Rotate a credential value', tags: ['Credentials'], security: HUMAN,
        parameters: [projectId, pathParam('credId', 'Credential id.')],
        requestSchema: { type: 'object', required: ['value'], properties: { value: { type: 'string', format: 'password' } } },
        requestExample: { value: 'example-rotated-key-value' },
        successDescription: 'Rotated credential metadata.', successExample: { id: 'cred-1', status: 'active' },
        errorStatuses: [400, 401, 403, 404, 503],
      }),
    },
    '/v1/projects/{id}/credentials/{credId}/revoke': {
      post: operation({
        operationId: 'revokeCredential', summary: 'Revoke a credential (leases denied immediately)', tags: ['Credentials'], security: HUMAN,
        parameters: [projectId, pathParam('credId', 'Credential id.')],
        successDescription: 'Credential revoked.', successExample: { ok: true, id: 'cred-1', status: 'revoked' },
        errorStatuses: [401, 403, 404],
      }),
    },
    '/v1/projects/{id}/api-keys': {
      post: operation({
        operationId: 'mintGatewayKey', summary: 'Mint a gateway API key (secret shown once, DP-07)', tags: ['Gateway keys'], security: HUMAN,
        parameters: [projectId],
        requestSchema: { type: 'object', properties: { label: { type: 'string' }, expires_at: { type: 'string', format: 'date-time' } } },
        requestExample: { label: 'CI pipeline' },
        successStatus: 201, successDescription: 'Key metadata plus the one-time secret (hash at rest thereafter).',
        successExample: { id: 'key-1', label: 'CI pipeline', key_prefix: 'cf_live_…', secret: 'cf_live_… (full secret shown once, never stored)', status: 'active' },
        errorStatuses: [400, 401, 403, 404],
      }),
      get: operation({
        operationId: 'listGatewayKeys', summary: 'Gateway keys (prefix only, never secrets)', tags: ['Gateway keys'], security: HUMAN,
        parameters: [projectId], successDescription: 'Keys with last-used timestamps.',
        successExample: { keys: [{ id: 'key-1', label: 'CI pipeline', key_prefix: 'cf_live_example…', status: 'active' }] },
        errorStatuses: [401, 404],
      }),
    },
    '/v1/projects/{id}/api-keys/{keyId}/revoke': {
      post: operation({
        operationId: 'revokeGatewayKey', summary: 'Revoke a gateway key (soft revoke)', tags: ['Gateway keys'], security: HUMAN,
        parameters: [projectId, pathParam('keyId', 'Gateway key id.')],
        successDescription: 'Key revoked.', successExample: { ok: true, id: 'key-1', status: 'revoked' },
        errorStatuses: [401, 403, 404],
      }),
    },
    '/v1/invites/{token}': {
      get: operation({
        operationId: 'getInvite', summary: 'Public invite info (token is the capability)', tags: ['Invites'], security: PUBLIC,
        description: 'Unknown, expired, and redeemed tokens all return the same generic 404 (SE-10).',
        parameters: [pathParam('token', 'Invite token (shown once to the inviter).')],
        successDescription: 'Workspace + role awaiting acceptance.', successExample: { invite: { customer_name: 'Acme', role: 'editor', expires_at: '2026-10-11T00:00:00.000Z' } },
        errorStatuses: [404],
      }),
    },
    '/v1/invites/{token}/redeem': {
      post: operation({
        operationId: 'redeemInvite', summary: 'Redeem an invite (signed-in, email-bound, single-use)', tags: ['Invites'], security: HUMAN,
        parameters: [pathParam('token', 'Invite token.')],
        successDescription: 'Membership activated.', successExample: { ok: true, customer_id: 'cust-1', role: 'editor' },
        errorStatuses: [401, 403, 404],
      }),
    },
    '/v1/mcp/{projectId}': {
      post: operation({
        operationId: 'mcpEndpoint', summary: 'Hosted MCP server (Streamable HTTP, RL-03)', tags: ['MCP'], security: GATEWAY_OR_HUMAN,
        description: 'JSON-RPC 2.0: initialize (2025-03-26 / 2024-11-05 negotiation), tools/list from the frozen snapshot, tools/call delegating to invoke. Tool failures are isError results; protocol failures are JSON-RPC errors. GET returns 405 (no SSE stream by design).',
        parameters: [
          pathParam('projectId', 'Project id.'),
          queryParam('version', 'Pinned version or staging/prod alias (default prod).'),
        ],
        requestExample: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'getForecast', arguments: { latitude: 52.52, longitude: 13.41 } } },
        successDescription: 'JSON-RPC response envelope.',
        successExample: { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: '{"temperature_2m":21.5}' }] } },
        errorStatuses: [400, 401, 403, 404],
      }),
    },
    '/v1/gpt-actions/{projectId}/{version}/{toolName}': {
      post: operation({
        operationId: 'gptActionInvoke', summary: 'GPT Actions execution surface (RL-04)', tags: ['GPT Actions'], security: GATEWAY_OR_HUMAN,
        description: 'Bare tool args in, bare result out (the OpenAI editor contract). Delegates to invoke; failures map by condition (429/404/403/502).',
        parameters: [
          pathParam('projectId', 'Project id.'),
          pathParam('version', 'Pinned version or staging/prod alias.'),
          pathParam('toolName', 'Tool name from the release snapshot.'),
        ],
        requestExample: { latitude: 52.52, longitude: 13.41 },
        successDescription: 'Bare tool result.', successExample: { temperature_2m: 21.5 },
        errorStatuses: [400, 401, 403, 404, 429, 502],
      }),
    },
  };
}

/** The full control-plane contract. Pure and deterministic — safe to cache. */
export function buildControlPlaneOpenApi(): JsonObject {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Connector Foundry API',
      version: API_DOCS_VERSION,
      description:
        'Control plane (human JWT) + gateway-key data-plane surfaces for Connector Foundry: import a REST API spec, review and approve generated tools, evaluate against the live upstream, publish MCP / OpenAI connectors, and operate them. Errors share one shape ({ error, code, request_id }); list endpoints use keyset pagination (?limit=&cursor=).',
      contact: { name: 'Connector Foundry', email: 'hello@connectorfoundry.com' },
    },
    servers: [{ url: 'http://localhost:4000', description: 'Local development (API on :4000, console on :5174).' }],
    tags: [
      { name: 'Health', description: 'Liveness.' },
      { name: 'API docs', description: 'This contract (CD-02).' },
      { name: 'Identity', description: 'Who am I; self-serve organization creation.' },
      { name: 'Admin', description: 'Platform-operator plane (requirePlatformAdmin).' },
      { name: 'Team', description: 'Workspace roster, invites, roles.' },
      { name: 'Billing', description: 'Plans, checkout, portal, invoices, metered usage.' },
      { name: 'Projects', description: 'Project registry, export, deletion.' },
      { name: 'Sources', description: 'Spec import and review queue.' },
      { name: 'Tools', description: 'Compilation and tool curation.' },
      { name: 'Jobs', description: 'Async compile/eval queue.' },
      { name: 'Evaluation', description: 'Live sandbox suites, history, reports, certification.' },
      { name: 'Releases', description: 'Freeze, sign, promote, rollback, artifacts.' },
      { name: 'Runtime', description: 'Data-plane invoke and Operate telemetry.' },
      { name: 'Credentials', description: 'Upstream API-key broker (values never returned).' },
      { name: 'Gateway keys', description: 'Consumer keys for scripts and MCP/GPT clients.' },
      { name: 'Invites', description: 'Token redemption.' },
      { name: 'MCP', description: 'Hosted Model Context Protocol endpoint.' },
      { name: 'GPT Actions', description: 'OpenAI GPT Actions execution surface.' },
    ],
    security: [{ BearerAuth: [] }],
    components: buildComponents(),
    paths: { ...buildPathsA(), ...buildPathsB() },
  };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

interface PathItem { [method: string]: { summary?: string; operationId?: string } }

/** Plain, dependency-free HTML index rendered from the spec (no JS/CSS assets). */
export function renderApiReferenceHtml(spec: JsonObject): string {
  const info = spec.info as { title?: string; version?: string };
  const paths = spec.paths as Record<string, PathItem>;
  const rows: string[] = [];
  for (const [path, item] of Object.entries(paths)) {
    for (const [method, op] of Object.entries(item)) {
      rows.push(
        `<tr><td>${escapeHtml(method.toUpperCase())}</td><td>${escapeHtml(path)}</td>` +
        `<td>${escapeHtml(op.summary ?? '')}</td><td>${escapeHtml(op.operationId ?? '')}</td></tr>`,
      );
    }
  }
  return [
    '<!DOCTYPE html>',
    '<html lang="en"><head><meta charset="utf-8">',
    `<title>${escapeHtml(info.title ?? 'API')} — reference</title></head><body>`,
    `<h1>${escapeHtml(info.title ?? 'API')} <small>v${escapeHtml(info.version ?? '')}</small></h1>`,
    '<p>Machine-readable contract: <a href="/v1/openapi.json">/v1/openapi.json</a> (OpenAPI 3.1). ' +
      'Control-plane calls use a Cognito Bearer JWT; data-plane calls also accept a project gateway key ' +
      '(Authorization: Bearer cf_live_… or X-API-Key: cf_live_…).</p>',
    '<table><thead><tr><th>Method</th><th>Path</th><th>Summary</th><th>Operation</th></tr></thead>',
    `<tbody>${rows.join('')}</tbody></table>`,
    '</body></html>',
  ].join('\n');
}

let cachedSpec: JsonObject | null = null;
let cachedHtml: string | null = null;

function specOnce(): JsonObject {
  cachedSpec ??= buildControlPlaneOpenApi();
  return cachedSpec;
}

/** Public docs routes: GET /v1/openapi.json + GET /v1/docs (no auth — no secrets in either). */
export const apiDocsRouter = Router();
apiDocsRouter.get('/openapi.json', (_req, res) => {
  res.json(specOnce());
});
apiDocsRouter.get('/docs', (_req, res) => {
  cachedHtml ??= renderApiReferenceHtml(specOnce());
  res.type('html').send(cachedHtml);
});
