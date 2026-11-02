// Agent task suite (EV-08 / HK-07): propose tasks, score transcripts, run
// the suite inside an eval run.
//
// Scoring follows the harness's verdict ladder: deterministic checks first
// (the agent answered; it called every expected tool; it called no
// forbidden or unknown tool), and only then an LLM judge on the answer
// rubric. The judge can fail a task, never rescue one.

import { q, exec, jb, uid } from '../db.js';
import { BudgetedLlm, extractJson, truncatedStopReason, type LlmClient } from '../llm/index.js';
import { logger } from '../logger.js';
import { allCalls, runAgent, type AgentTool, type AgentTranscript } from './runner.js';
import { candidateExecutor, candidateToolset } from './executors.js';

export interface AgentTaskRow {
  id: string;
  project_id: string;
  prompt: string;
  expected_tools: unknown;
  forbidden_tools: unknown;
  answer_rubric: string | null;
  source: string;
  status: string;
}

export interface TaskCheck {
  name: 'answered' | 'expected_tools_called' | 'no_forbidden_tools' | 'no_unknown_tools' | 'answer_rubric';
  passed: boolean;
  detail?: string;
}

export interface TaskScore {
  passed: boolean;
  checks: TaskCheck[];
  toolCalls: number;
  wrongToolCalls: number;
  failedCalls: number;
  invalidArgCalls: number;
}

function names(v: unknown): string[] {
  let list = v;
  if (typeof v === 'string') {
    try { list = JSON.parse(v); } catch { list = []; }
  }
  return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : [];
}

/** Deterministic checks on a transcript (no model involved). */
export function scoreTranscript(task: Pick<AgentTaskRow, 'expected_tools' | 'forbidden_tools'>, t: AgentTranscript): TaskScore {
  const calls = allCalls(t);
  const called = new Set(calls.filter((c) => c.known).map((c) => c.name));
  const expected = names(task.expected_tools);
  const forbidden = new Set(names(task.forbidden_tools));
  const missing = expected.filter((n) => !called.has(n));
  const forbiddenCalls = calls.filter((c) => forbidden.has(c.name));
  const unknownCalls = calls.filter((c) => !c.known);
  const failed = calls.filter((c) => c.known && !c.result.ok && !c.result.dryRun);
  const invalidArgs = failed.filter((c) => c.result.status === 400 || c.result.status === 422);
  const answered = t.stoppedBy === 'answer' && t.finalAnswer.trim().length > 0;
  const checks: TaskCheck[] = [
    { name: 'answered', passed: answered, ...(answered ? {} : { detail: t.error ?? `stopped: ${t.stoppedBy}` }) },
    { name: 'expected_tools_called', passed: missing.length === 0, ...(missing.length ? { detail: `not called: ${missing.join(', ')}` } : {}) },
    { name: 'no_forbidden_tools', passed: forbiddenCalls.length === 0, ...(forbiddenCalls.length ? { detail: `called: ${[...new Set(forbiddenCalls.map((c) => c.name))].join(', ')}` } : {}) },
    { name: 'no_unknown_tools', passed: unknownCalls.length === 0, ...(unknownCalls.length ? { detail: `invented: ${[...new Set(unknownCalls.map((c) => c.name))].join(', ')}` } : {}) },
  ];
  return {
    passed: checks.every((c) => c.passed),
    checks,
    toolCalls: calls.length,
    wrongToolCalls: forbiddenCalls.length + unknownCalls.length,
    failedCalls: failed.length,
    invalidArgCalls: invalidArgs.length,
  };
}

export const JUDGE_SYSTEM_PROMPT =
  'You grade an AI assistant\'s final answer against a rubric. Reply with JSON only: {"pass": true|false, "reason": "<one sentence>"}.';

/** LLM judge for the answer rubric. Only called when the deterministic checks passed. */
export async function judgeAnswer(llm: LlmClient, prompt: string, answer: string, rubric: string): Promise<TaskCheck> {
  const started = Date.now();
  try {
    const res = await llm.chat({
      system: JUDGE_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: `User request:\n${prompt}\n\nAssistant answer:\n${answer}\n\nRubric:\n${rubric}` }],
      maxTokens: 200,
    });
    const verdict = extractJson<{ pass?: unknown; reason?: unknown }>(res.text);
    const check: TaskCheck = { name: 'answer_rubric', passed: verdict.pass === true, detail: String(verdict.reason ?? '').slice(0, 300) };
    logger.info({
      msg: 'agent.judge', duration_ms: Date.now() - started, passed: check.passed,
      stop_reason: res.stopReason, truncated: truncatedStopReason(res.stopReason),
    });
    return check;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    logger.warn({ msg: 'agent.judge_failed', duration_ms: Date.now() - started, error: message });
    return { name: 'answer_rubric', passed: false, detail: `judge unavailable: ${message}` };
  }
}

export const TASK_GENERATOR_PROMPT = [
  'You write evaluation tasks for an AI agent that will use the tools of one API.',
  'Write realistic requests a real end user would type, in their own words, without naming tools.',
  'Most tasks must be answerable with the read tools. Include one task that needs two tools in sequence,',
  'and one task where the agent must NOT call a write tool (put that tool in forbidden_tools).',
  'Only use tool names from the list. Reply with ONLY the raw JSON array (no fences, no prose): an array of',
  '{"prompt": string, "expected_tools": string[], "forbidden_tools": string[], "answer_rubric": string}.',
].join(' ');

export interface ProposedTask {
  prompt: string;
  expected_tools: string[];
  forbidden_tools: string[];
  answer_rubric: string;
}

function describeTools(tools: AgentTool[]): string {
  return tools.map((t) => {
    const props = Object.keys((t.inputSchema.properties as Record<string, unknown>) ?? {});
    return `- ${t.name} [${t.accessClass}] (${props.join(', ') || 'no arguments'}): ${t.description.replace(/\s+/g, ' ').slice(0, 300)}`;
  }).join('\n');
}

function toProposedTasks(raw: unknown, known: Set<string>): ProposedTask[] {
  const list = Array.isArray(raw) ? raw : [];
  const clean = (v: unknown) => names(v).filter((n) => known.has(n));
  return list
    .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object' && typeof (x as any).prompt === 'string')
    .map((x) => ({
      prompt: String(x.prompt).trim().slice(0, 1000),
      expected_tools: clean(x.expected_tools),
      forbidden_tools: clean(x.forbidden_tools),
      answer_rubric: typeof x.answer_rubric === 'string' ? x.answer_rubric.trim().slice(0, 1000) : '',
    }))
    .filter((t) => t.prompt.length > 0)
    .slice(0, 8);
}

/**
 * Salvage complete task objects out of a truncated reply: scan for
 * top-level balanced {...} spans (string-aware, so braces inside quoted
 * text don't count) and parse each one. A reply cut off mid-array still
 * yields every task that finished before the cut.
 */
export function extractTaskObjects(text: string): unknown[] {
  const out: unknown[] = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        try {
          out.push(JSON.parse(text.slice(start, i + 1)));
        } catch { /* skip the broken span, keep scanning */ }
        start = -1;
      }
      if (depth < 0) { depth = 0; start = -1; }
    }
  }
  return out;
}

/** Generation attempts: one normal shot, then repair-nudged retries. */
const PROPOSE_ATTEMPTS = 3;
const PROPOSE_MAX_TOKENS = 4000;

/** Ask the model for tasks; keeps only well-formed ones that name real tools. */
export async function proposeTasks(llm: LlmClient, projectName: string, tools: AgentTool[], count = 6): Promise<ProposedTask[]> {
  const started = Date.now();
  const toolList = describeTools(tools);
  const known = new Set(tools.map((t) => t.name));
  const base = `API: ${projectName}\nWrite ${count} tasks.\nTools:\n${toolList}`;
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= PROPOSE_ATTEMPTS; attempt++) {
    // Later attempts pin the temperature down and tell the model plainly
    // the last reply was unusable — nondeterministic prose is the common
    // failure, and it usually clears on a steadier retry.
    const res = await llm.chat({
      system: TASK_GENERATOR_PROMPT,
      messages: [{
        role: 'user',
        content: attempt === 1 ? base
          : `${base}\n\nYour previous reply was not a valid JSON array. Reply now with ONLY the raw JSON array, no fences, no prose.`,
      }],
      maxTokens: PROPOSE_MAX_TOKENS,
      temperature: attempt === 1 ? 0.4 : 0.1,
    });
    const truncated = truncatedStopReason(res.stopReason);
    if (truncated) {
      logger.warn({
        msg: 'agent.propose_truncated', attempt, duration_ms: Date.now() - started,
        tool_count: tools.length, tool_list_chars: toolList.length,
        text_len: res.text.length, stop_reason: res.stopReason,
      });
    }
    // Rescue complete tasks before judging the reply: a truncated array
    // still holds every task that finished, and a lone object reply is a
    // usable task even though it is not the requested array.
    const rescue = (): ProposedTask[] | null => {
      const salvaged = toProposedTasks(extractTaskObjects(res.text), known);
      if (salvaged.length === 0) return null;
      logger.info({
        msg: 'agent.propose_salvaged', attempt, duration_ms: Date.now() - started,
        salvaged: salvaged.length, stop_reason: res.stopReason, truncated,
      });
      return salvaged;
    };
    try {
      const kept = toProposedTasks(extractJson<unknown>(res.text), known);
      if (kept.length === 0) return rescue() ?? kept;
      logger.info({
        msg: 'agent.propose', attempt, duration_ms: Date.now() - started,
        tool_count: tools.length, tool_list_chars: toolList.length,
        kept: kept.length,
        stop_reason: res.stopReason, truncated,
      });
      return kept;
    } catch (e) {
      lastError = e;
      const salvaged = rescue();
      if (salvaged) return salvaged;
      logger.warn({
        msg: 'agent.propose_retry', attempt, duration_ms: Date.now() - started,
        error: e instanceof Error ? e.message : String(e), stop_reason: res.stopReason,
      });
    }
  }
  throw lastError;
}

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

/**
 * Run every approved task against the project's current tools and store
 * the results under the eval run. The agent suite reports alongside the
 * harness suites; it does not change the run's pass/fail or certification
 * (model behavior varies run to run — it is evidence, not a gate yet).
 */
export async function runAgentSuite(projectId: string, runId: string, llm: LlmClient | null): Promise<AgentSuiteSummary> {
  const tasks = (await q(
    `SELECT * FROM eval_agent_tasks WHERE project_id = $1 AND status = 'approved' ORDER BY created_at, id`,
    [projectId])) as AgentTaskRow[];
  if (tasks.length === 0) {
    return { status: 'not_tested', reason: 'No approved agent tasks. Generate or write tasks on the Evaluate screen.' };
  }
  if (!llm) {
    return { status: 'not_tested', reason: 'No language model is configured on this server.' };
  }
  const budgeted = new BudgetedLlm(llm);
  const toolset = await candidateToolset(projectId);
  const execute = candidateExecutor(projectId, toolset);
  let passed = 0;
  const totals = { calls: 0, wrong: 0, failed: 0, invalid: 0, tokens: 0 };
  for (const [i, task] of tasks.entries()) {
    const taskStarted = Date.now();
    const transcript = await runAgent({ llm: budgeted, prompt: task.prompt, tools: toolset.tools, execute });
    const score = scoreTranscript(task, transcript);
    if (score.passed && task.answer_rubric?.trim()) {
      const judged = await judgeAnswer(budgeted, task.prompt, transcript.finalAnswer, task.answer_rubric);
      score.checks.push(judged);
      score.passed = judged.passed;
    }
    const tokens = transcript.usage.inputTokens + transcript.usage.outputTokens;
    if (score.passed) passed += 1;
    logger.info({
      msg: 'agent.task', task_index: i, task_id: task.id, duration_ms: Date.now() - taskStarted,
      passed: score.passed, steps: transcript.steps.length, stopped_by: transcript.stoppedBy,
      tool_calls: score.toolCalls, wrong_tool_calls: score.wrongToolCalls,
      failed_calls: score.failedCalls, tokens,
    });
    totals.calls += score.toolCalls;
    totals.wrong += score.wrongToolCalls;
    totals.failed += score.failedCalls;
    totals.invalid += score.invalidArgCalls;
    totals.tokens += tokens;
    await exec(
      `INSERT INTO eval_agent_results (id, eval_run_id, task_id, prompt, passed, checks, steps, tool_calls,
         wrong_tool_calls, failed_calls, invalid_arg_calls, tokens, duration_ms, provider, model, transcript)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
      [uid(), runId, task.id, task.prompt, score.passed, jb(score.checks), transcript.steps.length, score.toolCalls,
        score.wrongToolCalls, score.failedCalls, score.invalidArgCalls, tokens, transcript.durationMs,
        transcript.provider, transcript.model, jb(transcript)]);
  }
  const n = tasks.length;
  return {
    status: passed === n ? 'passed' : 'failed',
    passed,
    failed: n - passed,
    metrics: {
      tasks: n,
      success_rate: Math.round((passed / n) * 1000) / 10,
      tool_calls_per_task: Math.round((totals.calls / n) * 10) / 10,
      wrong_tool_calls: totals.wrong,
      failed_calls: totals.failed,
      invalid_arg_calls: totals.invalid,
      tokens: totals.tokens,
    },
    provider: llm.provider,
    model: llm.model,
  };
}
