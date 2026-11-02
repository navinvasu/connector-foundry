// ─── Connector Foundry — canonical UI data model ─────────────────────────────
// The UI consumes this model through the store (store.ts); data/api.ts maps
// the control-plane API's shapes onto it.

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export type Effect = 'READ' | 'WRITE' | 'DESTRUCTIVE' | 'UNKNOWN';
export type Severity = 'blocker' | 'warning' | 'info';

// ─── API source (import screen) ──────────────────────────────────────────────

export interface ApiSource {
  id: string;
  name: string;
  specKind: string;          // "OpenAPI 3.1.0"
  apiVersion: string;        // vendor API version, e.g. "2026-09-01"
  baseUrl: string;
  hostVerified: boolean;
  operationCount: number;
  schemaCount: number;
  recursiveSchemas: number;
  securitySchemes: string[];
  importedAt: string;
}

export interface Operation {
  fingerprint: string;
  method: HttpMethod;
  path: string;
  summary: string;
  effect: Effect;
  docScore: number;          // 0–100 documentation completeness
  schemaComplexity: 'low' | 'medium' | 'high';
  authScheme: string;
  deprecated: boolean;
  recommendation: 'include' | 'exclude' | 'review';
  excludeReason?: string;
  userJobs: string[];        // plain-language jobs this op supports
}

export interface Finding {
  id: string;
  severity: Severity;
  code: 'SCHEMA' | 'HOST' | 'EFFECT' | 'ERROR' | 'AUTH';
  title: string;
  detail: string;
  /** The suggested fix from the API (review item recommendation). */
  recommendation?: string;
  operationRef?: string;     // method + path
  /** Backend tool id when the finding came from an evaluated/compiled tool. */
  toolId?: string | null;
  /** Informational items have no user resolution: they are acknowledged. */
  status: 'open' | 'resolved' | 'acknowledged';
}

// ─── Tools (curation screen) ─────────────────────────────────────────────────

export interface ToolParam {
  name: string;
  type: string;
  required: boolean;
  description: string;
}

export interface ParamBinding {
  arg: string;               // tool argument name
  location: 'path' | 'query' | 'body' | 'header';
  target: string;            // upstream parameter name
}

export interface ErrorMapping {
  raw: string;               // e.g. "422 validation_failed"
  mapped: string;            // e.g. "VALIDATION_ERROR"
  action: 'retry' | 'fix_params' | 'refresh_auth' | 'backoff' | 'escalate' | 'clarify';
  recovery: string;          // plain-language agent instruction
}

export interface AgentTool {
  name: string;
  upstream: string;          // "POST /repos/{owner}/{repo}/issues"
  intent: string;            // when an agent should reach for this tool
  description: string;
  effect: Effect;
  confirmation: 'NEVER' | 'WRITES' | 'ALWAYS';
  idempotency: 'NOT_REQUIRED' | 'REQUIRED';
  retry: string;             // plain-language retry policy
  scopes: string[];
  status: 'draft' | 'needs_review' | 'approved' | 'excluded';
  excludeReason?: string;
  inputSchema: ToolParam[];
  bindings: ParamBinding[];
  errorMappings: ErrorMapping[];
  breakingChange?: string;
  version: string;
}

// ─── Review queue ────────────────────────────────────────────────────────────

export type QuestionKind = 'ambiguity' | 'error_mapping' | 'effect' | 'auth' | 'exclusion';

export interface ReviewQuestion {
  id: string;
  kind: QuestionKind;
  title: string;
  detail: string;
  toolRef?: string;
  options?: { label: string; description: string }[];
  status: 'open' | 'answered';
  answer?: string;
}

// ─── Evaluation ──────────────────────────────────────────────────────────────

export type EvalCategory = 'selection' | 'arguments' | 'safety' | 'execution' | 'recovery';

export interface TraceStep {
  t: string;                 // timestamp / step label
  event: string;
}

export interface EvalScenario {
  id: string;
  /** EV-02: stable cross-run identity (tool|suite|scenario). */
  key?: string;
  /** Backend tool id (first key segment) — links a failure to its open review items. */
  toolId?: string | null;
  /** Upstream HTTP status for this scenario, when one was recorded. */
  statusCode?: number | null;
  name: string;
  category: EvalCategory;
  input: string;              // simulated user utterance
  expected: string;
  actual: string;
  result: 'pass' | 'fail';
  diagnosis?: string;
  trace?: TraceStep[];
}

export interface EvalRun {
  id: string;
  startedAt: string;
  outcome?: {
    total: number; passed: number; failed: number;
    passedTools: Array<{ tool_id: string; tool_name: string }>;
    failedTools: Array<{ tool_id: string; tool_name: string; failed_scenarios: number; categories: string[] }>;
    failuresByCategory: Array<{ category: string; label: string; tool_count: number; suggestion: string }>;
  } | null;
  sandbox: string;
  scenarioCount: number;
  passCount: number;
  failCount: number;
  byCategory: { category: EvalCategory; pass: number; total: number }[];
  scenarios: EvalScenario[];
}

// ─── Publish ─────────────────────────────────────────────────────────────────

export interface PublishTarget {
  name: string;
  status: 'ready' | 'staging' | 'verify' | 'blocked';
  detail: string;
}

export interface Release {
  version: string;
  digest: string;
  apiVersion: string;
  toolCount: number;
  breakingChanges: number;
  status: 'draft' | 'candidate' | 'approved' | 'released' | 'active';
  checklist: { label: string; done: boolean; detail: string }[];
  targets: PublishTarget[];
}

// ─── Operate ─────────────────────────────────────────────────────────────────

export interface UsagePoint {
  day: string;
  calls: number;
  errors: number;
  p95Ms: number;
}

/** One bucket of data-plane telemetry. `ts` is the bucket start; `label` is
 *  the display text (day or hour depending on granularity). */
export interface TelemetryPoint {
  ts: number;
  label: string;
  calls: number;
  errors: number;
  p95Ms: number;
}

export interface DriftAlert {
  id: string;
  severity: Severity;
  title: string;
  detail: string;
  time: string;
  action: string;
}

export interface Incident {
  id: string;
  title: string;
  detail: string;
  severity: Severity;
  time: string;
  status: 'open' | 'investigating' | 'resolved';
}

export interface PromptPattern {
  prompt: string;
  tool: string;
  calls: number;
  successRate: number;
}

export interface UnmappedPrompt {
  prompt: string;
  count: number;
  suggestion: string;
}

export interface ToolUsage {
  tool: string;
  calls: number;
  note?: string;
}

export interface ProviderHealth {
  quotaLabel: string;
  quotaUsed: number;
  quotaPct: number;
  rateLimitHits: number;
  tokenRefreshes: number;
  tokenFailures: number;
}

export interface FeedbackSignals {
  abandoned: number;
  abandonRate: number;
  corrections: number;
  thumbsDown: number;
}

export interface CorrectionDetail {
  id: string;
  original: string;
  rephrased: string;
  tool: string;
  count: number;
  reason: string;
}

export interface AbandonedDetail {
  id: string;
  prompt: string;
  tool: string;
  count: number;
  error: string;
}

export interface ThumbsDownDetail {
  id: string;
  tool: string;
  prompt: string;
  count: number;
  note: string;
}

export interface FixChange {
  label: string;
  before: string;
  after: string;
}

export interface FixSuggestion {
  id: string;
  priority: 'high' | 'medium' | 'low';
  issue: string;
  fix: string;
  actionLabel: string;
  route: string;
  changes: FixChange[];
}
