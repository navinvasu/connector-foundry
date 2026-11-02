// Client for the agent features: agent tasks (EV-08), fix suggestions
// (HK-09), the playground, release changes and prompt capture (D-89).

import { api } from './api';

export interface AgentTask {
  id: string;
  prompt: string;
  expected_tools: string[];
  forbidden_tools: string[];
  answer_rubric: string | null;
  source: 'owner' | 'llm';
  status: 'proposed' | 'approved' | 'rejected';
  model: string | null;
}

export interface AgentCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  known: boolean;
  result: { ok: boolean; status?: number; body: unknown; error?: string; latencyMs: number; dryRun?: boolean };
}

export interface AgentTranscript {
  turnId: string;
  prompt: string;
  steps: Array<{ index: number; text: string; toolCalls: AgentCall[] }>;
  finalAnswer: string;
  stoppedBy: 'answer' | 'max_steps' | 'budget' | 'error';
  error?: string;
  usage: { inputTokens: number; outputTokens: number };
  provider: string;
  model: string;
  durationMs: number;
}

export interface AgentResult {
  id: string;
  task_id: string;
  prompt: string;
  passed: boolean;
  checks: Array<{ name: string; passed: boolean; detail?: string }>;
  steps: number;
  tool_calls: number;
  wrong_tool_calls: number;
  failed_calls: number;
  invalid_arg_calls: number;
  tokens: number;
  duration_ms: number;
  model: string | null;
  transcript: AgentTranscript | null;
}

/** summary.agent on an eval run. */
export interface AgentSuiteSummary {
  status: 'passed' | 'failed' | 'not_tested';
  reason?: string;
  passed?: number;
  failed?: number;
  metrics?: {
    tasks: number;
    success_rate: number;
    tool_calls_per_task: number;
    wrong_tool_calls: number;
    failed_calls: number;
    invalid_arg_calls: number;
    tokens: number;
  };
  provider?: string;
  model?: string;
}

export interface FixSuggestion {
  id: string;
  tool_id: string;
  tool_name: string | null;
  field: 'description' | 'eligible_use' | 'ineligible_use' | 'param_description';
  param: string | null;
  before_text: string | null;
  after_text: string;
  rationale: string;
  evidence: string[];
  status: 'proposed' | 'accepted' | 'rejected';
  model: string | null;
  created_at: string;
}

export interface ReleaseChanges {
  release: { id: string; version: string };
  base: { id: string; version: string } | null;
  changes: Array<{
    tool: string;
    change: 'added' | 'removed' | 'changed';
    fields?: Array<{ field: string; before: unknown; after: unknown }>;
  }>;
  eval: {
    release: { id: string; status: string; summary: { agent?: AgentSuiteSummary } | null } | null;
    base: { id: string; status: string; summary: { agent?: AgentSuiteSummary } | null } | null;
  };
}

const json = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });

export const listAgentTasks = (projectId: string) =>
  api<{ tasks: AgentTask[] }>(`/v1/projects/${projectId}/agent-tasks`);

export const createAgentTask = (projectId: string, task: { prompt: string; expected_tools?: string[]; forbidden_tools?: string[]; answer_rubric?: string }) =>
  api<{ task: AgentTask }>(`/v1/projects/${projectId}/agent-tasks`, json(task));

export const generateAgentTasks = (projectId: string) =>
  api<{ tasks: AgentTask[]; model: string; tokens: number }>(`/v1/projects/${projectId}/agent-tasks/generate`, { method: 'POST' });

export const updateAgentTask = (projectId: string, taskId: string, patch: Partial<Pick<AgentTask, 'status' | 'prompt' | 'answer_rubric'>>) =>
  api<{ task: AgentTask }>(`/v1/projects/${projectId}/agent-tasks/${taskId}`, { method: 'PATCH', body: JSON.stringify(patch) });

export const deleteAgentTask = (projectId: string, taskId: string) =>
  api<void>(`/v1/projects/${projectId}/agent-tasks/${taskId}`, { method: 'DELETE' });

export const listAgentResults = (projectId: string, runId: string) =>
  api<{ results: AgentResult[] }>(`/v1/projects/${projectId}/eval/runs/${runId}/agent-results`);

export const listSuggestions = (projectId: string) =>
  api<{ suggestions: FixSuggestion[] }>(`/v1/projects/${projectId}/suggestions`);

export const generateSuggestions = (projectId: string) =>
  api<{ suggestions: FixSuggestion[]; evidence: number; message?: string; model?: string }>(
    `/v1/projects/${projectId}/suggestions/generate`, { method: 'POST' });

export const acceptSuggestion = (projectId: string, id: string, after?: string) =>
  api<{ ok: true }>(`/v1/projects/${projectId}/suggestions/${id}/accept`, json(after ? { after } : {}));

export const rejectSuggestion = (projectId: string, id: string) =>
  api<{ ok: true }>(`/v1/projects/${projectId}/suggestions/${id}/reject`, { method: 'POST' });

export const runPlayground = (projectId: string, prompt: string, version?: string) =>
  api<{ release_version: string; transcript: AgentTranscript }>(
    `/v1/projects/${projectId}/playground`, json({ prompt, ...(version ? { version } : {}) }));

export const getReleaseChanges = (releaseId: string, against?: string) =>
  api<ReleaseChanges>(`/v1/releases/${releaseId}/changes${against ? `?against=${encodeURIComponent(against)}` : ''}`);

export const setPromptCapture = (projectId: string, capture: boolean) =>
  api<{ project: unknown }>(`/v1/projects/${projectId}`, { method: 'PATCH', body: JSON.stringify({ capture_prompts: capture }) });

/** Human label for a suggestion's target ("description", "argument `id`"). */
export function suggestionTarget(s: Pick<FixSuggestion, 'field' | 'param'>): string {
  if (s.field === 'param_description') return `argument "${s.param}"`;
  if (s.field === 'eligible_use') return 'when to use';
  if (s.field === 'ineligible_use') return 'when not to use';
  return 'description';
}

/** Before/after agent metrics for two runs (null side = no agent data). */
export function compareAgentRuns(before: AgentSuiteSummary | undefined, after: AgentSuiteSummary | undefined) {
  const m = (s?: AgentSuiteSummary) => (s?.status !== 'not_tested' ? s?.metrics : undefined);
  const b = m(before);
  const a = m(after);
  const row = (label: string, key: keyof NonNullable<AgentSuiteSummary['metrics']>, better: 'up' | 'down', unit = '') => {
    const bv = b?.[key];
    const av = a?.[key];
    const delta = bv !== undefined && av !== undefined ? Math.round((av - bv) * 10) / 10 : null;
    const improved = delta === null || delta === 0 ? null : better === 'up' ? delta > 0 : delta < 0;
    return { label, before: bv, after: av, delta, improved, unit };
  };
  return [
    row('Task success', 'success_rate', 'up', '%'),
    row('Tool calls per task', 'tool_calls_per_task', 'down'),
    row('Wrong / invented tool calls', 'wrong_tool_calls', 'down'),
    row('Invalid-argument calls', 'invalid_arg_calls', 'down'),
    row('Failed calls', 'failed_calls', 'down'),
    row('Tokens', 'tokens', 'down'),
  ];
}

/** Per-task flips between two runs' agent results, matched by task id. */
export function agentTaskFlips(before: AgentResult[], after: AgentResult[]) {
  const prev = new Map(before.map((r) => [r.task_id, r]));
  return after.map((r) => {
    const p = prev.get(r.task_id);
    const change = !p ? 'new' : p.passed === r.passed ? (r.passed ? 'still_passing' : 'still_failing') : r.passed ? 'fixed' : 'regressed';
    return { taskId: r.task_id, prompt: r.prompt, before: p ?? null, after: r, change } as const;
  });
}
