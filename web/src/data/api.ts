// ─── Connector Foundry — live backend client ─────────────────────────────────
// Talks to the control/data-plane server (default http://localhost:4000) and
// maps backend shapes onto the UI data model (data/types.ts).

import type {
  AgentTool, Effect, EvalRun, EvalScenario, EvalCategory, Finding, Operation,
} from './types';
import type { ConnectorTarget, ProjectSummary } from './projects';
import { getAccessToken } from '../features/auth/cognito';
import { logAction } from '../shared/lib/diagnostics';
import { formatRunDateTime, outcomeFromSummary } from '../features/evaluate/evalOutcome';
import { classifyReviewItem } from './reviewKind';

export const API_BASE: string =
  (import.meta as any).env?.VITE_API_BASE_URL ?? 'http://localhost:4000';

// Auth: when Cognito is wired (FE-01) the Bearer token is the Cognito access JWT from
// @vir/web-auth (refreshed when < 5 min remain). In local dev (CF_DEV_AUTH=true) no token is
// needed — the server signs you in as the seeded platform-admin dev user.

// FE-03: typed API errors so the console can render designed states for
// machine-readable server codes (e.g. `project_limit_reached`) instead of
// matching on message text. A subclass of Error — existing `catch (e) =>
// String(e)` paths keep working unchanged.
export class ApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  /** The parsed error body — carries server-supplied context (e.g. the
   *  FE-03 project-limit fields) alongside the message. */
  readonly details: unknown;
  constructor(status: number, message: string, code: string | null, details: unknown = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const token = await getAccessToken();
  // IN-09: dev persona headers. The Layout persona switcher (dev builds
  // only) stores these in localStorage; the server honors them only under
  // CF_DEV_AUTH, so they are inert against a production deployment.
  const devAs = typeof localStorage !== 'undefined' ? localStorage.getItem('cf-dev-as') : null;
  const devAsAdmin = typeof localStorage !== 'undefined' ? localStorage.getItem('cf-dev-as-admin') : null;
  const method = init?.method ?? 'GET';
  // The label carries the route, never the query string; bodies are never
  // logged. request_id joins this entry to the server's `request` log line.
  const label = `${method} ${path.split('?')[0]}`;
  const started = Date.now();
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(devAs ? { 'x-dev-as': devAs } : {}),
      ...(devAsAdmin === '1' ? { 'x-dev-as-admin': '1' } : {}),
      ...(init?.headers ?? {}),
    },
  });
  const request_id = res.headers.get('x-request-id') ?? undefined;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new ApiError(res.status, (body as any).error ?? `Request failed: ${res.status}`, (body as any).code ?? null, body);
    logAction('api', label, { status: res.status, code: err.code, error: err.message, request_id }, Date.now() - started, false);
    throw err;
  }
  logAction('api', label, { status: res.status, request_id }, Date.now() - started, true);
  return body as T;
}

export const health = () => api<{ ok: boolean }>('/health');

// ─── Backend shapes (loose) ──────────────────────────────────────────────────

interface BackendTool {
  id: string; name: string; description: string; purpose: string;
  eligible_use: string; ineligible_use: string;
  input_schema: { properties?: Record<string, any>; required?: string[] };
  upstream: { method: string; path_template: string; base_url: string;
              param_bindings: { arg: string; location: string; target: string }[] };
  effect_classes: string[]; confirmation_required: boolean; idempotent: boolean;
  required_scopes: string[]; confidence: number; version: number; status: string;
  recovery_rules: { condition: string; behavior: string; user_message: string }[];
}

const effectMap: Record<string, Effect> = {
  read_only: 'READ', mutating: 'WRITE', destructive: 'DESTRUCTIVE',
};
const statusMap: Record<string, AgentTool['status']> = {
  candidate: 'draft', needs_decision: 'needs_review', approved: 'approved',
  tested: 'approved', released: 'approved',
};
const actionMap: Record<string, 'retry' | 'fix_params' | 'refresh_auth' | 'backoff' | 'escalate' | 'clarify'> = {
  auto_recover: 'retry', retry_changed: 'backoff', escalate_user: 'escalate', terminal: 'clarify',
};

export function mapTool(t: BackendTool): AgentTool {
  const props = t.input_schema?.properties ?? {};
  const required = new Set(t.input_schema?.required ?? []);
  return {
    name: t.name,
    upstream: `${t.upstream?.method ?? ''} ${t.upstream?.path_template ?? ''}`.trim(),
    intent: t.purpose ?? t.description,
    description: t.description,
    effect: effectMap[t.effect_classes?.[0]] ?? 'UNKNOWN',
    confirmation: t.confirmation_required ? 'ALWAYS' : 'NEVER',
    idempotency: t.idempotent ? 'REQUIRED' : 'NOT_REQUIRED',
    retry: 'Policy from recovery rules; see error mappings.',
    scopes: t.required_scopes ?? [],
    status: statusMap[t.status] ?? 'draft',
    inputSchema: Object.entries(props).map(([name, p]: [string, any]) => ({
      name, type: String(p.type ?? 'string'), required: required.has(name),
      description: String(p.description ?? ''),
    })),
    bindings: (t.upstream?.param_bindings ?? []).map((b) => ({
      arg: b.arg,
      location: b.location as 'path' | 'query' | 'body' | 'header',
      target: b.target,
    })),
    errorMappings: (t.recovery_rules ?? []).map((r) => ({
      raw: r.condition, mapped: r.condition,
      action: actionMap[r.behavior] ?? 'escalate',
      recovery: r.user_message,
    })),
    version: `v${t.version}`,
  };
}

export function toolBackendId(t: AgentTool): string | undefined {
  return (t as any).__backendId;
}
export function withBackendId(t: AgentTool, id: string): AgentTool {
  return Object.assign(t, { __backendId: id });
}

// ─── Import ──────────────────────────────────────────────────────────────────

interface ImportResponse {
  source: { id: string; title: string; version: string; base_url: string;
            operations: number; schemas: number; security_schemes: string[] };
  inventory: {
    operations: { method: string; path: string; summary: string; effect: Effect;
                  doc_score: number; deprecated: boolean; auth_schemes: string[] }[];
    findings: { code: Finding['code']; severity: 'blocker' | 'warning';
                title: string; detail: string; operationRef?: string }[];
  };
}

export async function importSpec(projectId: string, spec: unknown) {
  return api<ImportResponse>(`/v1/projects/${projectId}/sources`, {
    method: 'POST', body: JSON.stringify({ type: 'openapi_json', payload: spec }),
  });
}

export function mapOperations(inv: ImportResponse['inventory']['operations']): Operation[] {
  return inv.map((op, i) => ({
    fingerprint: `${op.method} ${op.path}#${i}`,
    method: op.method as Operation['method'],
    path: op.path,
    summary: op.summary,
    effect: op.effect,
    docScore: op.doc_score,
    schemaComplexity: 'low' as const,
    authScheme: op.auth_schemes?.[0] ?? 'none',
    deprecated: op.deprecated,
    recommendation: op.effect === 'READ' ? 'include' as const : 'review' as const,
    userJobs: [],
  }));
}

export function mapFindings(inv: ImportResponse['inventory']['findings']): Finding[] {
  return inv.map((f, i) => ({
    id: `live-${Date.now()}-${i}`,
    severity: f.severity, code: f.code, title: f.title, detail: f.detail,
    operationRef: f.operationRef, status: 'open' as const,
  }));
}

// ─── Eval ────────────────────────────────────────────────────────────────────

const categoryMap: Record<string, EvalCategory> = {
  contract: 'arguments', behavior: 'execution', recovery: 'recovery',
  safety: 'safety', auth: 'safety',
};

interface EvalResponse {
  run: { id: string; status: string; started_at: string;
         summary: { suites: Record<string, { status: string }> } };
  results: { suite: string; scenario: string; passed: boolean;
             latency_ms: number | null; detail: any }[];
}

export async function runEval(projectId: string) {
  // Queue-backed: enqueue, wait for the worker, then fetch the finished run.
  const { job } = await enqueueEval(projectId);
  const done = await pollJob(job.id);
  if (done.status !== 'succeeded') throw new Error(done.error ?? 'Evaluation job failed');
  const runId = (done.result as any)?.run_id as string | undefined;
  if (!runId) throw new Error('Evaluation finished without a run id');
  const { run, results } = await getEvalRun(runId);
  return {
    run: { id: run.id, status: run.status, started_at: run.started_at, summary: run.summary },
    results,
  } as EvalResponse;
}

export function mapEvalRun(r: EvalResponse): EvalRun {
  const scenarios: EvalScenario[] = r.results.map((s, i) => {
    const d = s.detail ?? {};
    return {
      id: `s-${i}`,
      name: s.scenario.replace(/_/g, ' '),
      category: categoryMap[s.suite] ?? 'execution',
      input: String(d.url ?? s.scenario),
      expected: expectedFor(s.scenario),
      actual: `${d.status ?? 'no response'}${s.latency_ms != null ? ` in ${s.latency_ms}ms` : ''}` +
              (d.mapped_condition ? ` → ${d.mapped_condition}` : '') +
              (d.behavior ? ` (${d.behavior})` : ''),
      result: s.passed ? 'pass' : 'fail',
      diagnosis: d.error ?? (s.passed ? undefined : 'See detail in backend eval_results.'),
    };
  });
  const byCategory = [...new Set(scenarios.map((s) => s.category))].map((category) => {
    const ss = scenarios.filter((s) => s.category === category);
    return { category, pass: ss.filter((s) => s.result === 'pass').length, total: ss.length };
  });
  return {
    id: r.run.id,
    startedAt: r.run.started_at,
    sandbox: 'live upstream API',
    scenarioCount: scenarios.length,
    passCount: scenarios.filter((s) => s.result === 'pass').length,
    failCount: scenarios.filter((s) => s.result === 'fail').length,
    byCategory,
    scenarios,
  };
}

function expectedFor(scenario: string): string {
  if (scenario.includes('happy_path')) return '2xx with a JSON body';
  if (scenario.includes('missing_params')) return 'Handled: 4xx rejection or documented 200 defaults';
  if (scenario.includes('task_fields')) return 'Response carries task-relevant fields';
  if (scenario.includes('invalid_input')) return 'Invalid input maps to a recovery condition';
  return 'Pass';
}

// ─── Release / runtime / telemetry ───────────────────────────────────────────

export async function createRelease(projectId: string, version: string) {
  return api<{ release_id: string; version: string; manifest: any }>(
    `/v1/projects/${projectId}/releases`, { method: 'POST', body: JSON.stringify({ version }) });
}
export async function approveRelease(releaseId: string) {
  return api(`/v1/releases/${releaseId}/approve`, { method: 'POST', body: JSON.stringify({}) });
}
/** RL-07: move an approved release between channels (default prod). */
export async function promoteRelease(releaseId: string, channel: 'staging' | 'prod' = 'prod') {
  return api<{ release_id: string; version: string; channel: string; promoted: boolean }>(
    `/v1/releases/${releaseId}/promote`, { method: 'POST', body: JSON.stringify({ channel }) });
}

/** RL-08: the prod-promotion checklist — what's missing + how to fix it. */
export interface PromotionCheck {
  id: string; label: string; status: 'pass' | 'fail'; detail: string; action: string;
}
export interface PromotionReadiness {
  release_id: string; version: string; channel: string;
  ready: boolean; certified: boolean; run_id: string | null;
  checks: PromotionCheck[];
}
export const getPromotionReadiness = (releaseId: string) =>
  api<PromotionReadiness>(`/v1/releases/${releaseId}/promotion-readiness`);
export function downloadManifest(releaseId: string) {
  window.open(`${API_BASE}/v1/releases/${releaseId}/manifest`, '_blank');
}
/** RL-03: download the stdio bridge for the build-time (local) MCP setup. */
export function downloadStdioBridge(releaseId: string) {
  window.open(`${API_BASE}/v1/releases/${releaseId}/mcp/stdio`, '_blank');
}
/** RL-04: download the OpenAI function-calling tools for the release. */
export function downloadOpenAiTools(releaseId: string) {
  window.open(`${API_BASE}/v1/releases/${releaseId}/openai/tools`, '_blank');
}
/** RL-04: open the GPT Actions OpenAPI document for the release. */
export function downloadGptActionsSpec(releaseId: string) {
  window.open(`${API_BASE}/v1/releases/${releaseId}/openai/actions`, '_blank');
}
/** HK-08: download the Meta Muse submission kit for the release. */
export function downloadMuseKit(releaseId: string) {
  window.open(`${API_BASE}/v1/releases/${releaseId}/muse/kit`, '_blank');
}

export interface MuseKitGateReason { tool: string; reason: string; message: string }
export interface MuseKitSummary {
  connector: { name: string; version: string; release_id: string; description: string };
  connection: { type: string; mcp_endpoint: string; note: string };
  tools: { name: string; access_class: string; confirmation: string }[];
  review_gate: { eligible: boolean; reasons: MuseKitGateReason[] };
}

/** HK-08: read the Muse submission kit (gate result + endpoint) for display. */
export const getMuseKit = (releaseId: string) =>
  api<MuseKitSummary>(`/v1/releases/${releaseId}/muse/kit`);

/** Item 5: upstream API key metadata (never the secret itself). */
export interface CredentialMeta {
  id: string; label: string; kind: string; status: string;
  key_fingerprint: string | null; created_at: string; rotated_at: string | null;
}

export const listCredentials = (projectId: string) =>
  api<{ credentials: CredentialMeta[] }>(`/v1/projects/${projectId}/credentials`);

export const saveCredential = (projectId: string, label: string, value: string) =>
  api<{ credential: CredentialMeta }>(`/v1/projects/${projectId}/credentials`, {
    method: 'POST', body: JSON.stringify({ label, value }),
  });

export const rotateCredential = (projectId: string, credentialId: string, value: string) =>
  api<{ credential: CredentialMeta }>(
    `/v1/projects/${projectId}/credentials/${credentialId}/rotate`,
    { method: 'POST', body: JSON.stringify({ value }) });

export const revokeCredential = (projectId: string, credentialId: string) =>
  api<{ credential: CredentialMeta }>(
    `/v1/projects/${projectId}/credentials/${credentialId}/revoke`, { method: 'POST' });

/** D-89: one attribution bucket (trigger, client, channel or release version). */
export interface TelemetryBucket { key: string; calls: number; ok_calls: number; avg_ms: number }

export interface Telemetry {
  by_status: { status: string; n: number; avg_ms: number }[];
  by_tool: { tool_name: string; calls: number; ok_calls: number; avg_ms: number }[];
  recent: { tool_name: string; status: string; latency_ms: number;
            prompt_ref: string | null; created_at: string;
            channel?: string | null; client?: string | null; trigger?: string | null;
            trigger_source?: string | null; prompt_text?: string | null; release_version?: string | null }[];
  by_trigger?: TelemetryBucket[];
  by_client?: TelemetryBucket[];
  by_channel?: TelemetryBucket[];
  by_release?: TelemetryBucket[];
  top_prompts?: { prompt: string; calls: number; turns: number; last_seen_at: string }[];
  capture_prompts?: boolean;
}
export const fetchTelemetry = (projectId: string) =>
  api<Telemetry>(`/v1/projects/${projectId}/telemetry`);

export async function invokeTool(projectId: string, version: string, toolName: string, args: Record<string, unknown>) {
  return api(`/v1/runtime/invoke`, {
    method: 'POST',
    body: JSON.stringify({ project_id: projectId, version, tool_name: toolName, args }),
  });
}

// ─── Gateway API keys (DP-07) ────────────────────────────────────────────────
// Project-scoped consumer keys for the data plane. The secret is returned
// exactly once (in the create response); lists carry metadata only.

export interface GatewayKey {
  id: string; project_id: string; label: string; prefix: string;
  status: 'active' | 'revoked';
  created_by: string | null; created_at: string;
  expires_at: string | null; revoked_at: string | null; last_used_at: string | null;
}
export interface GatewayKeyList {
  api_keys: GatewayKey[];
  caller_role: 'owner' | 'editor' | 'viewer' | null;
}
export interface CreatedGatewayKey extends GatewayKey { secret: string }

export const listGatewayKeys = (projectId: string) =>
  api<GatewayKeyList>(`/v1/projects/${projectId}/api-keys`);
export const createGatewayKey = (projectId: string, body: { label: string; expires_at?: string }) =>
  api<CreatedGatewayKey>(`/v1/projects/${projectId}/api-keys`, {
    method: 'POST', body: JSON.stringify(body),
  });
export const revokeGatewayKey = (projectId: string, keyId: string) =>
  api<{ ok: boolean; id: string; status: string }>(`/v1/projects/${projectId}/api-keys/${keyId}/revoke`, {
    method: 'POST', body: JSON.stringify({}),
  });

// ─── Drift detection (TE-03) ─────────────────────────────────────────────

export interface DriftAlertRow {
  id: string; project_id: string; tool_id: string; tool_name: string;
  status: 'open' | 'resolved'; first_seen_at: string; last_seen_at: string;
  resolved_at: string | null;
  evidence: { failed_scenarios?: string[]; release_id?: string } | null;
}
export interface DriftCheckSummary {
  release_id?: string; release_version?: string; status?: string;
  tools_checked: number; tools_passed: number;
  tools_failed: { tool_id: string; tool_name: string; failed_scenarios?: string[] }[];
  tools_skipped: { tool_id: string; tool_name: string; reason?: string }[];
}
export interface DriftCheckRow {
  id: string; project_id: string; release_id: string | null;
  trigger: 'schedule' | 'manual'; status: 'running' | 'succeeded' | 'failed';
  summary: DriftCheckSummary | null; error: string | null;
  started_at: string; finished_at: string | null;
}
interface PageMeta { limit: number; has_more: boolean; next_cursor: string | null }

export const listDriftAlerts = (projectId: string, status: 'open' | 'resolved' | 'all' = 'open') =>
  api<{ alerts: DriftAlertRow[]; pagination: PageMeta; caller_role: 'owner' | 'editor' | 'viewer' | null }>(
    `/v1/projects/${projectId}/drift/alerts?status=${status}`);
export const listDriftChecks = (projectId: string) =>
  api<{ checks: DriftCheckRow[]; pagination: PageMeta }>(
    `/v1/projects/${projectId}/drift/checks`);
export const triggerDriftCheck = (projectId: string) =>
  api<{ job: { id: string; kind: string; status: string }; deduplicated: boolean }>(
    `/v1/projects/${projectId}/drift/check`, { method: 'POST' });

// ─── Onboarding: plans, customers, users ─────────────────────────────────────

export interface Plan {
  id: string; name: string; seat_cap: number; project_cap: number;
  telemetry_retention_days: number; is_trial: boolean; trial_duration_days: number | null;
}

export interface Customer {
  id: string; name: string; slug: string | null; plan_id: string; plan_name: string;
  status: 'trialing' | 'active' | 'trial_expired' | 'suspended';
  stripe_customer_id: string | null; trial_started_at: string | null; trial_ends_at: string | null;
  /** Effective seat cap (BL-05: seat_override ?? plan cap). */
  seat_cap: number; project_cap: number; telemetry_retention_days: number; is_trial: boolean;
  seats_used: number; projects_used: number; created_at: string;
  /** BL-05 staff seat override; null = plan default. */
  seat_override: number | null;
  seat_override_reason?: string | null;
  seat_override_by?: string | null;
  seat_override_at?: string | null;
}

export interface Member {
  membership_id: string; user_id: string; email: string; full_name: string | null;
  role: 'owner' | 'editor' | 'viewer'; status: string; joined_at: string | null;
  invite_expires_at: string | null; last_login_at: string | null; invited_by_email?: string | null;
}

export const listPlans = () => api<{ plans: Plan[] }>('/v1/admin/plans');
export const listCustomers = () => api<{ customers: Customer[] }>('/v1/admin/customers');
export const getCustomer = (id: string) =>
  api<{ customer: Customer; members: Member[] }>(`/v1/admin/customers/${id}`);
export const createCustomer = (body: {
  name: string; plan_id?: string; start_trial?: boolean; owner_email?: string; owner_name?: string;
}) => api<{ customer: Customer }>('/v1/admin/customers', { method: 'POST', body: JSON.stringify(body) });
export const updateCustomer = (id: string, body: { name?: string; plan_id?: string; status?: string }) =>
  api<{ customer: Customer }>(`/v1/admin/customers/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
export const suspendCustomer = (id: string) =>
  api<{ customer: Customer }>(`/v1/admin/customers/${id}/suspend`, { method: 'POST' });
/** BL-05: set (or clear, with null) a customer's total seat override. */
export const adjustCustomerSeats = (id: string, seats: number | null, reason?: string) =>
  api<{ customer: Customer }>(`/v1/admin/customers/${id}/seats`, {
    method: 'PATCH', body: JSON.stringify({ seats, reason }),
  });
export const reactivateCustomer = (id: string) =>
  api<{ customer: Customer }>(`/v1/admin/customers/${id}/reactivate`, { method: 'POST' });

export const listMembers = (customerId: string) =>
  api<{ members: Member[]; usage: Usage }>(`/v1/customers/${customerId}/users`);
export const getUsage = (customerId: string) =>
  api<Usage & { customer: Customer }>(`/v1/customers/${customerId}/usage`);
export const inviteMember = (customerId: string, body: { email: string; role?: string; full_name?: string }) =>
  api(`/v1/customers/${customerId}/users/invite`, { method: 'POST', body: JSON.stringify(body) });
export const updateMember = (customerId: string, userId: string, body: { role?: string; status?: string }) =>
  api(`/v1/customers/${customerId}/users/${userId}`, { method: 'PATCH', body: JSON.stringify(body) });
export const removeMember = (customerId: string, userId: string) =>
  api(`/v1/customers/${customerId}/users/${userId}`, { method: 'DELETE' });

/**
 * FE-08: the roster's last active owner can't be demoted or removed (the
 * server answers 409); the Team page disables those two controls with the
 * reason up front instead of letting the click fail. Mirrors the guard in
 * backend members.ts — the API stays the real gate.
 */
export function isSoleActiveOwner(members: Member[], member: Member): boolean {
  if (member.role !== 'owner' || member.status !== 'active') return false;
  return members.filter((m) => m.role === 'owner' && m.status === 'active').length <= 1;
}

// ─── Billing: trial → paid (Stripe) ──────────────────────────────────────────

export interface BillingPlan {
  id: string; name: string; seat_cap: number; project_cap: number;
  telemetry_retention_days: number; price_display: string | null; purchasable: boolean;
}

export interface BillingStatus {
  id: string; name: string; status: string; plan_id: string; plan_name: string;
  price_display: string | null; trial_ends_at: string | null;
  has_stripe_customer: boolean; has_subscription: boolean; billing_email: string | null;
}

export const listBillingPlans = () =>
  api<{ plans: BillingPlan[]; billing_enabled: boolean }>('/v1/billing/plans');
export const getBilling = (customerId: string) =>
  api<{ billing: BillingStatus; billing_enabled: boolean }>(`/v1/customers/${customerId}/billing`);
export const startCheckout = (customerId: string, plan_id: string) =>
  api<{ url: string }>(`/v1/customers/${customerId}/billing/checkout`, {
    method: 'POST', body: JSON.stringify({ plan_id }),
  });
export const openBillingPortal = (customerId: string) =>
  api<{ url: string }>(`/v1/customers/${customerId}/billing/portal`, { method: 'POST' });

export interface Invoice {
  id: string; number: string | null; amount_due: number; currency: string;
  status: string | null; created: string; hosted_url: string | null;
}
export const listInvoices = (customerId: string) =>
  api<{ invoices: Invoice[] }>(`/v1/customers/${customerId}/billing/invoices`);

export interface Usage {
  seats_used: number; seat_cap: number; projects_used: number; project_cap: number;
  /** BL-05: staff-granted total (null = plan default applies). */
  seat_override: number | null;
  plan_seat_cap: number;
}

export function trialDaysLeft(c: Customer): number | null {
  if (c.status !== 'trialing' || !c.trial_ends_at) return null;
  return Math.max(0, Math.ceil((new Date(c.trial_ends_at).getTime() - Date.now()) / 86400_000));
}

// ─── Projects: the real registry (PostgreSQL via /v1/projects) ───────────────

export interface BackendProject {
  id: string; name: string; description: string | null;
  targets: string[] | null; customer_id: string | null; customer_name: string | null;
  status: string; created_at: string; updated_at: string;
  operations_count: number; tools_total: number; tools_approved: number;
  open_review_items: number; latest_source_type: string | null; latest_source_location: string | null;
}

export interface WorkspaceMembership {
  customer_id: string; customer_name: string; customer_status: string;
  plan_id: string; plan_name: string; role: 'owner' | 'editor' | 'viewer';
  membership_status: string; writable: boolean; project_cap: number;
  /** FE-03: plan retention window for the telemetry locked states. */
  telemetry_retention_days: number;
  trial_ends_at: string | null;
}

export interface Me {
  user: { id: string; email: string; full_name: string | null; is_platform_admin: boolean };
  memberships: WorkspaceMembership[];
}

export const getMe = () => api<Me>('/v1/me');

// FE-07: a signed-in user with no membership creates their own organization
// (trial plan; the caller becomes its owner) instead of hitting a dead end.
export interface CreatedOrganization {
  customer: Customer;
}

export const createOrganization = (body: { name: string }) =>
  api<CreatedOrganization>('/v1/me/organization', { method: 'POST', body: JSON.stringify(body) });

/**
 * FE-07: does this signed-in user still need the "Create your organization"
 * step? Platform admins are operators (they onboard via the admin screen,
 * and the dev identity always holds a workspace), so they never
 * land there; everyone else lands there exactly when they hold no active
 * membership — the same condition the server enforces with a 409.
 */
export function needsOrganization(me: Me | null): boolean {
  if (!me || me.user.is_platform_admin) return false;
  return !me.memberships.some((m) => m.membership_status === 'active');
}

/**
 * FE-13: the console has two planes. Platform admins operate the service
 * (Admin → Customers: provision workspaces, set plans/licenses,
 * suspend/reactivate); workspace members run connectors (Projects, Build,
 * Release, Run). The shell follows the identity, not a static menu:
 * staff with no workspace membership land on Admin and never see tenant
 * workflows; tenant users never see Admin; someone holding both (the
 * founder, the local dev identity) sees both planes. Creating projects
 * or releases is tenant work — staff performing it on a customer's
 * behalf would break the "service proposes, customer approves" rule,
 * so the operator plane deliberately has no path into it.
 */
export interface ConsoleShell {
  showAdmin: boolean;
  showTenant: boolean;
  landing: string;
}

export function shellFor(me: Me | null): ConsoleShell {
  // Identity not loaded yet (or /v1/me failed): fail closed on Admin —
  // never flash the operator plane at a tenant. Tenant pages carry their
  // own empty/error states while identity resolves.
  if (!me) return { showAdmin: false, showTenant: true, landing: '/dashboard' };
  const showAdmin = me.user.is_platform_admin;
  const showTenant = me.memberships.some((m) => m.membership_status === 'active');
  const landing = showTenant ? '/dashboard' : showAdmin ? '/admin/customers' : '/organizations/new';
  return { showAdmin, showTenant, landing };
}

export const listProjects = () =>
  api<{ projects: BackendProject[] }>('/v1/projects');

export const createProject = (body: {
  name: string; description?: string; targets: string[]; customer_id: string;
}) => api<{ project: BackendProject }>('/v1/projects', { method: 'POST', body: JSON.stringify(body) });

export const updateProjectTargets = (id: string, targets: string[]) =>
  api<{ project: BackendProject }>(`/v1/projects/${id}`, {
    method: 'PATCH', body: JSON.stringify({ targets }),
  });

/** Rename / re-describe / retarget a project (owner or editor). */
export const updateProject = (id: string, body: { name?: string; description?: string | null; targets?: string[] }) =>
  api<{ project: BackendProject }>(`/v1/projects/${id}`, {
    method: 'PATCH', body: JSON.stringify(body),
  });

/** Permanently delete a project and everything it owns (owner-only; no undo). */
export const deleteProject = (id: string) =>
  api<{ ok: boolean; project_id: string; deleted: Record<string, number> }>(`/v1/projects/${id}`, { method: 'DELETE' });

export interface ImportResult {
  /** Compile job auto-started with the import — null when the import added
   *  nothing new (same spec again), so there is nothing to compile. */
  compile_job: { id: string; status: string } | null;
  source: {
    id: string; title: string; version: string; base_url: string;
    operations: number; schemas: number; security_schemes: string[];
  };
  inventory: {
    operations: { method: string; path: string; summary: string; effect: string; doc_score: number }[];
    findings: { severity: string; title: string }[];
  };
}

/**
 * Import an API spec into a project.
 * @param type 'openapi_url' / 'postman_url' (server fetches the URL),
 *   'openapi_text' (raw JSON/YAML text from an uploaded file), or
 *   'postman_text' (a raw Postman Collection v2.1 from a file — IA-02).
 */
export const importSource = (projectId: string, type: 'openapi_url' | 'openapi_text' | 'postman_url' | 'postman_text', payload: string) =>
  api<ImportResult>(`/v1/projects/${projectId}/sources`, {
    method: 'POST', body: JSON.stringify({ type, payload }),
  });

function timeAgo(iso: string): string {
  const s = Math.max(1, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d} day${d === 1 ? '' : 's'} ago`;
  const w = Math.floor(d / 7);
  if (w < 5) return `${w} week${w === 1 ? '' : 's'} ago`;
  return new Date(iso).toLocaleDateString();
}

/** Backend project row → the ProjectSummary the screens render. */
export function mapBackendProject(p: BackendProject): ProjectSummary {
  const targets = (p.targets ?? []).filter(
    (t): t is ConnectorTarget => t === 'mcp' || t === 'openai' || t === 'muse',
  );
  return {
    id: p.id,
    name: p.name,
    targets: targets.length > 0 ? targets : ['mcp', 'openai', 'muse'],
    status: p.operations_count > 0 ? 'in_review' : 'draft',
    version: 'v1 draft',
    toolsApproved: p.tools_approved,
    toolsTotal: p.tools_total,
    operationsCount: p.operations_count ?? 0,
    evalPassRate: null,
    evalSummary: 'eval not run yet',
    blockerCount: p.open_review_items,
    openQuestions: 0,
    updatedAt: timeAgo(p.updated_at),
    blurb: p.description?.trim() || 'No description yet.',
    sourceKind:
      p.latest_source_type === 'openapi_url' ? 'openapi-url'
      : p.latest_source_type === 'openapi_file' ? 'upload'
      : p.latest_source_type === 'postman' ? 'postman'
      : undefined,
    sourceDetail: p.latest_source_location ?? undefined,
    customerId: p.customer_id ?? undefined,
    customerName: p.customer_name ?? undefined,
  };
}

// ─── Processing queue ───────────────────────────────────────────────────────
// Long-running pipeline stages (compile, eval) run on a background worker.
// The UI enqueues (202) and polls the job until it reaches a terminal state.

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export type JobKind = 'compile' | 'eval';

export interface Job {
  id: string;
  project_id: string;
  kind: JobKind;
  status: JobStatus;
  progress: { done: number; total: number; note: string } | null;
  result: Record<string, any> | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

const TERMINAL: JobStatus[] = ['succeeded', 'failed', 'cancelled'];

export const enqueueCompile = (projectId: string) =>
  api<{ job: Job; deduplicated: boolean }>(`/v1/projects/${projectId}/compile`, { method: 'POST' });

export const enqueueEval = (projectId: string) =>
  api<{ job: Job; deduplicated: boolean }>(`/v1/projects/${projectId}/eval`, { method: 'POST' });

export const listJobs = (projectId: string, limit = 10) =>
  api<{ jobs: Job[] }>(`/v1/projects/${projectId}/jobs?limit=${limit}`);

export const getJob = (jobId: string) => api<{ job: Job }>(`/v1/jobs/${jobId}`);

/** Poll a job until it reaches a terminal state; resolves with the final job. */
export async function pollJob(
  jobId: string,
  onUpdate?: (j: Job) => void,
  intervalMs = 1500,
): Promise<Job> {
  for (;;) {
    const { job } = await getJob(jobId);
    onUpdate?.(job);
    if (TERMINAL.includes(job.status)) return job;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

// ─── Evaluation runs (real data) ────────────────────────────────────────────

export interface BackendEvalResult {
  id: string;
  tool_id: string | null;
  suite: string;
  scenario: string;
  passed: boolean;
  latency_ms: number | null;
  detail: Record<string, any>;
}

export interface BackendEvalRun {
  id: string;
  trigger: string;
  status: string;
  summary: {
    suites?: Record<string, { status: string; passed?: number; failed?: number; reason?: string }>;
    // EV-05: stored at run completion (criteria v1); the run-detail route
    // also computes it on read for older runs, so it may be absent only
    // on list rows for pre-EV-05 runs.
    certification?: BackendCertification;
    tools?: {
      total: number; passed: number; failed: number; passed_tool_ids: string[];
      /** Present on runs completed after the passed-list addition; older runs omit it. */
      passed_tools?: Array<{ tool_id: string; tool_name: string }>;
      failed_tools: Array<{ tool_id: string; tool_name: string; failed_scenarios: number; categories: string[] }>;
      failures_by_category: Array<{ category: string; label: string; tool_count: number; suggestion: string }>;
    };
  };
  started_at: string;
  finished_at: string | null;
}

// EV-05: the certification verdict behind the "Certified" badge —
// per-check pass/fail with explanations, judged under `criteria_version`.
export interface BackendCertification {
  certified: boolean;
  criteria_version: string;
  checks: Array<{ id: string; label: string; status: 'pass' | 'fail'; detail: string }>;
}

export const listEvalRuns = (projectId: string) =>
  api<{ runs: BackendEvalRun[] }>(`/v1/projects/${projectId}/eval/runs`);

export const getEvalRun = (runId: string) =>
  api<{ run: BackendEvalRun; results: BackendEvalResult[] }>(`/v1/projects/eval/runs/${runId}`);

export const keepPassedTools = (projectId: string, runId: string) =>
  api<{ total: number; passed: number; failed: number; kept_tools: string[]; excluded_tools: string[];
        failures_by_category: Array<{ category: string; label: string; tool_count: number; suggestion: string }> }>(
    `/v1/projects/${projectId}/eval/runs/${runId}/keep-passed`, { method: 'POST' });

// EV-03: the server renders the run as an HTML report, stores it in S3, and
// answers with a short-lived signed URL — the console just opens it.
export interface BackendEvalReport {
  run_id: string;
  format: string;
  /** Signed S3 URL when report storage is configured; absent for inline reports. */
  url?: string;
  /** Rendered HTML when report storage is not configured (local dev). */
  html?: string;
  inline?: boolean;
  expires_at: string | null;
  size_bytes: number;
}

export const getEvalReport = (projectId: string, runId: string) =>
  api<{ report: BackendEvalReport }>(`/v1/projects/${projectId}/eval/runs/${runId}/report`);

/**
 * Follow keyset pages to the end (BE-08): list endpoints cap a single
 * response (default 50 rows when no ?limit= is given, max 100), so one
 * request is never the full set. Endpoints without pagination answer the
 * first page with no `pagination` object, which ends the loop at once.
 */
async function listAll<T>(url: string, key: string): Promise<T[]> {
  const all: T[] = [];
  let cursor: string | null = null;
  // A stuck cursor must never spin forever: 100 pages is far past any real
  // project, and has_more=false ends the loop long before.
  for (let page = 0; page < 100; page++) {
    const sep = url.includes('?') ? '&' : '?';
    const qs = cursor ? `${sep}limit=100&cursor=${encodeURIComponent(cursor)}` : `${sep}limit=100`;
    const res: any = await api(`${url}${qs}`);
    all.push(...(res[key] ?? []));
    if (!res.pagination?.has_more || !res.pagination.next_cursor) break;
    cursor = res.pagination.next_cursor;
  }
  return all;
}

export const listProjectOperations = (projectId: string) =>
  listAll<{ id: string; method: string; path: string; summary: string; status: string }>(
    `/v1/projects/${projectId}/operations`, 'operations',
  ).then((operations) => ({ operations }));

export const listProjectTools = (projectId: string) =>
  listAll<{ id: string; name: string; status: string }>(
    `/v1/projects/${projectId}/tools`, 'tools',
  ).then((tools) => ({ tools }));

// EV-04: customer-authored eval scenarios (given args → expect shape/status).
// Enabled scenarios run inside every evaluation (suite `custom`) and gate
// release like a built-in failure.
export interface BackendCustomScenario {
  id: string;
  project_id: string;
  tool_id: string;
  name: string;
  given_args: Record<string, unknown>;
  expect_status: number | null;
  expect_body_keys: string[];
  enabled: boolean;
  created_by?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface CustomScenarioInput {
  name: string;
  given_args?: Record<string, unknown>;
  expect_status?: number | null;
  expect_body_keys?: string[];
  enabled?: boolean;
}

export const listEvalScenarios = (projectId: string, toolId: string) =>
  api<{ scenarios: BackendCustomScenario[] }>(`/v1/projects/${projectId}/tools/${toolId}/eval-scenarios`);

export const createEvalScenario = (projectId: string, toolId: string, input: CustomScenarioInput) =>
  api<{ scenario: BackendCustomScenario }>(`/v1/projects/${projectId}/tools/${toolId}/eval-scenarios`, {
    method: 'POST', body: JSON.stringify(input),
  });

export const updateEvalScenario = (
  projectId: string, toolId: string, scenarioId: string, input: Partial<CustomScenarioInput>,
) =>
  api<{ scenario: BackendCustomScenario }>(
    `/v1/projects/${projectId}/tools/${toolId}/eval-scenarios/${scenarioId}`, {
      method: 'PATCH', body: JSON.stringify(input),
    });

export const deleteEvalScenario = (projectId: string, toolId: string, scenarioId: string) =>
  api<{ ok: boolean; scenario_id: string }>(
    `/v1/projects/${projectId}/tools/${toolId}/eval-scenarios/${scenarioId}`, { method: 'DELETE' });

const suiteToCategory: Record<string, EvalCategory> = {
  contract: 'arguments',
  behavior: 'execution',
  recovery: 'recovery',
  auth: 'safety',
  safety: 'safety',
  custom: 'execution',
};

const scenarioLabels: Record<string, string> = {
  happy_path_2xx_json: 'Happy path returns 2xx JSON',
  missing_params_handled: 'Missing required params handled',
  response_carries_task_fields: 'Response carries task fields',
  invalid_input_handled: 'Invalid input handled (recovery)',
  write_invalid_payload_rejected: 'Write rejects a wrong-type payload',
  write_replay_idempotent: 'Idempotent write replays safely',
  write_confirmation_contract: 'Write requires confirmation',
};

/** Human-readable label for a backend eval scenario slug. */
export function evalScenarioLabel(scenario: string): string {
  return scenarioLabels[scenario] ?? scenario;
}

function customExpected(detail: Record<string, any> | undefined): string {
  if (!detail) return 'Pass';
  const status = detail.expect_status != null ? `HTTP ${detail.expect_status}` : '2xx success';
  const keys = Array.isArray(detail.expect_body_keys) && detail.expect_body_keys.length > 0
    ? ` with keys ${detail.expect_body_keys.join(', ')}` : '';
  return status + keys;
}

function scenarioExpected(scenario: string): string {
  switch (scenario) {
    case 'happy_path_2xx_json': return '2xx with a JSON object body';
    case 'missing_params_handled': return '4xx rejection, or 200 with documented defaults';
    case 'response_carries_task_fields': return '2xx with non-empty, task-relevant fields';
    case 'invalid_input_handled': return '4xx (BAD_REQUEST) or 200 with empty results (EMPTY_RESULT)';
    case 'write_invalid_payload_rejected': return '4xx rejection — a wrong-type payload must never be accepted as a write';
    case 'write_replay_idempotent': return 'Second identical call: no 5xx, consistent with the first';
    case 'write_confirmation_contract': return 'Tool contract carries confirmation_required, so the host asks before mutating';
    default: return 'Pass';
  }
}

function scenarioActual(r: BackendEvalResult): string {
  const d = r.detail ?? {};
  if (d.error) return String(d.error).slice(0, 160);
  const status = d.status != null ? `HTTP ${d.status}` : 'no response';
  if (r.suite === 'custom' && Array.isArray(d.body_keys) && d.body_keys.length > 0)
    return `${status}, keys: ${(d.body_keys as string[]).slice(0, 5).join(', ')}`;
  if (r.scenario === 'missing_params_handled' && d.behavior) return `${status} (${d.behavior})`;
  if (r.scenario === 'invalid_input_handled' && d.mapped_condition) return `${status} → ${d.mapped_condition}`;
  if (r.scenario === 'response_carries_task_fields' && d.top_level_keys)
    return `${status}, keys: ${(d.top_level_keys as string[]).slice(0, 5).join(', ')}`;
  return status;
}

function scenarioDiagnosis(r: BackendEvalResult): string | undefined {
  const d = r.detail ?? {};
  if (d.error) return `Request failed: ${String(d.error).slice(0, 200)}`;
  if (r.suite === 'custom' && !r.passed && Array.isArray(d.failures) && d.failures.length > 0)
    return (d.failures as string[]).join(' ');
  if (r.scenario === 'missing_params_handled' && d.behavior === 'defaulted_200')
    return 'Spec marks params required, but the API answers 200 with defaults — confirm the contract in review.';
  if (r.scenario === 'write_invalid_payload_rejected' && !r.passed)
    return 'The upstream accepted (or crashed on) a wrong-type payload instead of rejecting it with a 4xx — a malformed write must never land. Add input validation upstream, then re-run eval.';
  if (r.scenario === 'write_replay_idempotent' && !r.passed)
    return 'Replaying the same call twice was unsafe (5xx or inconsistent result) — make the operation idempotent or declare it non-idempotent so the host confirms each call.';
  if (r.scenario === 'write_confirmation_contract' && !r.passed)
    return 'This write tool does not carry confirmation_required, so an agent could mutate (or delete) without asking the user first. Recompile the tool to restore the confirmation contract.';
  if (!r.passed && d.status != null) return `Unexpected HTTP ${d.status} for this scenario.`;
  return undefined;
}

/** Map a backend eval run + results onto the console's EvalRun view model. */
export function mapBackendEvalRun(run: BackendEvalRun, results: BackendEvalResult[]): EvalRun {
  const scenarios: EvalScenario[] = results.map((r) => ({
    id: r.id,
    // EV-02: stable cross-run identity (tool|suite|scenario) — row ids are
    // minted per run. Keep in sync with evalScenarioKey in evalDiff.ts.
    key: `${r.tool_id ?? ''}|${r.suite}|${r.scenario}`,
    toolId: r.tool_id ?? null,
    statusCode: typeof r.detail?.status === 'number' ? r.detail.status as number : null,
    name: evalScenarioLabel(r.scenario),
    category: suiteToCategory[r.suite] ?? 'execution',
    input: r.detail?.url ?? r.scenario,
    expected: r.suite === 'custom' ? customExpected(r.detail) : scenarioExpected(r.scenario),
    actual: scenarioActual(r),
    result: r.passed ? 'pass' : 'fail',
    diagnosis: scenarioDiagnosis(r),
  }));
  const categories: EvalCategory[] = ['selection', 'arguments', 'safety', 'execution', 'recovery'];
  const byCategory = categories
    .map((category) => {
      const inCat = scenarios.filter((s) => s.category === category);
      return { category, pass: inCat.filter((s) => s.result === 'pass').length, total: inCat.length };
    })
    .filter((c) => c.total > 0);
  const passCount = scenarios.filter((s) => s.result === 'pass').length;
  return {
    id: run.id,
    // eval_runs has started_at (no created_at) — formatRunDateTime guards
    // missing/unparseable values so this never renders "Invalid Date".
    startedAt: formatRunDateTime(run.started_at),
    outcome: outcomeFromSummary(run.summary),
    sandbox: 'live upstream API · queue worker',
    scenarioCount: scenarios.length,
    passCount,
    failCount: scenarios.length - passCount,
    byCategory,
    scenarios,
  };
}

// ─── Dashboard (real project data) ──────────────────────────────────────────

export interface DashboardReviewItem {
  id: string;
  kind: string;
  title: string;
  status: string;
  severity: string | null;
  recommendation: string | null;
  evidence: Record<string, any>;
  tool_id: string | null;
  created_at: string;
}

export const listReviewItems = (projectId: string) =>
  listAll<DashboardReviewItem>(`/v1/projects/${projectId}/review`, 'review_items').then(
    (review_items) => ({ review_items }),
  );

const FINDING_CODES: Finding['code'][] = ['SCHEMA', 'HOST', 'EFFECT', 'ERROR', 'AUTH'];

/** A review item (import finding or eval ambiguity) → the Finding the build screens render. */
export function mapReviewFinding(r: DashboardReviewItem): Finding {
  const code = String(r.evidence?.code ?? '').toUpperCase() as Finding['code'];
  const knownCode = FINDING_CODES.includes(code) ? code : 'SCHEMA';
  return {
    id: r.id,
    severity: classifyReviewItem(r.kind, knownCode).severity,
    code: knownCode,
    title: r.title,
    detail: String(r.evidence?.detail ?? ''),
    recommendation: r.recommendation ?? undefined,
    operationRef: r.evidence?.operationRef ?? undefined,
    toolId: r.tool_id ?? null,
    status:
      r.status === 'open' ? 'open' : r.status === 'acknowledged' ? 'acknowledged' : 'resolved',
  };
}

export interface ReleaseSummary {
  id: string;
  version: string;
  status: string;
  channel: string | null;
  created_at: string;
}

export const getReleaseManifest = (releaseId: string) =>
  api<any>(`/v1/releases/${releaseId}/manifest`);

export const listReleases = (projectId: string) =>
  api<{ releases: ReleaseSummary[] }>(`/v1/projects/${projectId}/releases`);

export interface EvalSummary {
  runId: string;
  status: string;
  passRate: number;
  passCount: number;
  scenarioCount: number;
  finishedAt: string | null;
}

/** Latest evaluation run summarized for dashboard display; null when never run. */
export async function fetchEvalSummary(projectId: string): Promise<EvalSummary | null> {
  const { runs } = await listEvalRuns(projectId);
  if (runs.length === 0) return null;
  const { run, results } = await getEvalRun(runs[0].id);
  const passCount = results.filter((r) => r.passed).length;
  return {
    runId: run.id,
    status: run.status,
    passRate: results.length > 0 ? Math.round((passCount / results.length) * 100) : 0,
    passCount,
    scenarioCount: results.length,
    finishedAt: run.finished_at,
  };
}

/** Fresh project summary (counts included) for the dashboard. */
export const getProject = (projectId: string) =>
  api<{ project: BackendProject }>(`/v1/projects/${projectId}`).then(({ project }) =>
    mapBackendProject(project),
  );
