// Request-body validation (BE-04): every mutation validates its body with zod
// before touching the database. Malformed input gets a 400 with field-level
// messages instead of a 500 or a confusing downstream error.
import { z } from 'zod';
import type { NextFunction, Request, Response } from 'express';

/** Express middleware: 400 `{ error: 'invalid_request', fields }` on schema failure. */
export function validateBody<T extends z.ZodTypeAny>(schema: T) {
  return (req: Request, res: Response, next: NextFunction) => {
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) {
      const fields: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const path = issue.path.length ? issue.path.join('.') : '(body)';
        fields[path] ??= issue.message;
      }
      return res.status(400).json({ error: 'invalid_request', code: 'invalid_request', fields });
    }
    next();
  };
}

const nonEmpty = (label: string) =>
  z.string({ error: `${label} is required` }).trim().min(1, `${label} is required`);
const optNonEmpty = (label: string) =>
  z.string({ error: `${label} must be a string` }).trim().min(1, `${label} must not be empty`).optional();
const emailField = (label = 'A valid email is required') =>
  z.string({ error: label }).trim().email(label);

export const ROLES = ['owner', 'editor', 'viewer'] as const;

// POST /v1/projects
export const projectCreateSchema = z.object({
  name: nonEmpty('name'),
  description: z.string().max(2000).optional(),
  targets: z.array(z.string()).optional(),
  customer_id: z.string().min(1).optional(),
});

// PATCH /v1/projects/:id
export const projectPatchSchema = z.object({
  name: optNonEmpty('name'),
  description: z.string().max(2000).nullable().optional(),
  targets: z.array(z.string()).optional(),
  // D-89: opt-in storage of (redacted) prompt text in telemetry.
  capture_prompts: z.boolean().optional(),
});

// PATCH /v1/projects/tools/:toolId
export const toolPatchSchema = z.object({
  name: optNonEmpty('name'),
  description: z.string().max(4000).nullable().optional(),
  purpose: z.string().max(4000).nullable().optional(),
  eligible_use: z.string().max(4000).nullable().optional(),
  ineligible_use: z.string().max(4000).nullable().optional(),
  status: z.enum(['candidate', 'approved', 'tested']).optional(),
  // Effect class + confirmation rule are reviewer-editable: a "mutating
  // operation requires a decision" review item is resolved by confirming
  // these in Tools, then approving.
  effect_classes: z.array(z.enum(['read_only', 'mutating', 'destructive'])).min(1).max(3).optional(),
  confirmation_required: z.boolean().optional(),
  // HK-09: argument descriptions are what agents read to fill arguments.
  // Only descriptions are editable — types and required stay the spec's.
  param_descriptions: z.record(z.string(), z.string().max(2000)).optional(),
});

// POST /v1/projects/:id/sources
export const importSourceSchema = z.object({
  type: z.enum(['openapi_url', 'openapi_json', 'openapi_text', 'postman_url', 'postman_json', 'postman_text']),
  payload: z.unknown().refine((v) => v !== undefined && v !== null && v !== '',
    { message: 'payload is required' }),
});

// PATCH /v1/projects/review/:itemId
export const reviewItemSchema = z.object({
  status: z.enum(['resolved', 'dismissed', 'acknowledged']),
});

// POST /v1/projects/:id/releases
export const createReleaseSchema = z.object({
  version: nonEmpty('version'),
  // Scoped release: freeze only these tools (must belong to the project).
  tool_ids: z.array(z.string().uuid('tool_ids must be UUIDs')).min(1).max(500).optional(),
});

// POST /v1/projects/:id/eval — scoped run: evaluate only these tools.
export const evalRequestSchema = z.object({
  tool_ids: z.array(z.string().uuid('tool_ids must be UUIDs')).min(1).max(500).optional(),
});

// POST /v1/releases/:releaseId/approve
export const approveReleaseSchema = z.object({
  approver: z.string().trim().min(1).optional(),
});

// POST /v1/releases/:releaseId/rollback
export const rollbackReleaseSchema = z.object({
  reason: z.string().trim().max(500).optional(),
});

// POST /v1/releases/:releaseId/promote (RL-07) — defaults to prod.
export const promoteReleaseSchema = z.object({
  channel: z.enum(['staging', 'prod']).optional(),
});

// POST /v1/runtime/invoke
export const invokeSchema = z.object({
  project_id: nonEmpty('project_id'),
  version: nonEmpty('version'),
  tool_name: nonEmpty('tool_name'),
  args: z.record(z.string(), z.unknown()).optional(),
  prompt_ref: z.string().max(500).optional(),
  // D-89: a caller that knows why it is calling may say so (its own agent,
  // a scheduled job). Absent → a gateway-key call counts as automated.
  attribution: z.object({
    client: z.string().max(120).optional(),
    trigger: z.enum(['user_prompt', 'agent_followup', 'automated']).optional(),
    session_id: z.string().max(120).optional(),
    turn_id: z.string().max(120).optional(),
    prompt: z.string().max(4000).optional(),
  }).optional(),
});

// POST /v1/customers/:id/users/invite
export const inviteSchema = z.object({
  email: emailField(),
  role: z.enum(ROLES).optional(),
  full_name: z.string().trim().max(200).optional(),
});

// PATCH /v1/customers/:id/users/:userId
export const memberPatchSchema = z.object({
  role: z.enum(ROLES).optional(),
  status: z.enum(['active', 'suspended']).optional(),
});

// POST /v1/admin/customers
export const adminCustomerCreateSchema = z.object({
  name: nonEmpty('name'),
  plan_id: z.string().min(1).optional(),
  start_trial: z.boolean().optional(),
  owner_email: emailField().optional(),
  owner_name: z.string().trim().max(200).optional(),
});

// PATCH /v1/admin/customers/:id
export const adminCustomerPatchSchema = z.object({
  name: optNonEmpty('name'),
  plan_id: z.string().min(1).optional(),
  status: z.enum(['trialing', 'active', 'trial_expired', 'past_due', 'restricted', 'suspended']).optional(),
});

// PATCH /v1/admin/customers/:id/seats — BL-05 staff seat override.
// `seats: null` clears the override (back to the plan cap).
export const adminCustomerSeatsSchema = z.object({
  seats: z.number().int().min(1).max(10000).nullable(),
  reason: z.string().trim().max(500).optional(),
});

// PATCH /v1/admin/users/:id
export const adminUserPatchSchema = z.object({
  is_platform_admin: z.boolean().optional(),
  status: z.enum(['active', 'suspended']).optional(),
});

// POST /v1/me/organization (FE-07) — a signed-in user with no membership
// creates their own organization on the trial plan and becomes its owner.
export const orgCreateSchema = z.object({
  name: nonEmpty('name'),
});

// POST /v1/billing/:id/checkout
export const checkoutSchema = z.object({
  plan_id: nonEmpty('plan_id'),
});

// POST /v1/projects/:id/tools/:toolId/eval-scenarios (EV-04) — a
// customer-authored case: given args → expect shape/status. An unset
// expect_status means "expect 2xx"; an empty expect_body_keys means no
// shape assertion. Names are unique per tool (checked in the handler).
export const evalScenarioCreateSchema = z.object({
  name: z.string({ error: 'name is required' }).trim().min(1, 'name is required').max(120),
  given_args: z.record(z.string(), z.unknown()).optional(),
  expect_status: z.number().int().min(100).max(599).nullable().optional(),
  expect_body_keys: z.array(z.string().trim().min(1).max(100)).max(50).optional(),
  enabled: z.boolean().optional(),
});

// PATCH /v1/projects/:id/tools/:toolId/eval-scenarios/:scenarioId (EV-04)
export const evalScenarioPatchSchema = z.object({
  name: z.string({ error: 'name must be a string' }).trim().min(1, 'name must not be empty').max(120).optional(),
  given_args: z.record(z.string(), z.unknown()).optional(),
  expect_status: z.number().int().min(100).max(599).nullable().optional(),
  expect_body_keys: z.array(z.string().trim().min(1).max(100)).max(50).optional(),
  enabled: z.boolean().optional(),
});
