// Agent runner (EV-08 / HK-07, playground). A language model gets a task
// prompt and a project's tools, calls them through an executor, and
// answers. The same loop powers the agent task suite (candidate tools,
// before a release exists) and the console playground (a published
// release, through the data plane). Transcripts are redacted evidence.

import { randomUUID } from 'node:crypto';
import { logger } from '../logger.js';
import { redactValue } from '../redact.js';
import type { LlmClient, LlmMessage, LlmTool, LlmToolCall, LlmUsage } from '../llm/index.js';
import { LlmError } from '../llm/index.js';
import type { AccessClass } from '../tool-text.js';

export interface AgentTool extends LlmTool {
  accessClass: AccessClass;
}

export interface ExecResult {
  ok: boolean;
  status?: number;
  body: unknown;
  error?: string;
  latencyMs: number;
  /** The call was not sent (write tools under eval policy); body says what would have run. */
  dryRun?: boolean;
}

export interface ExecContext {
  turnId: string;
  step: number;
  prompt: string;
}

export type Executor = (call: LlmToolCall, tool: AgentTool | null, ctx: ExecContext) => Promise<ExecResult>;

export interface AgentToolCallRecord {
  id: string;
  name: string;
  args: Record<string, unknown>;
  known: boolean;
  result: ExecResult;
}

export interface AgentStep {
  index: number;
  text: string;
  toolCalls: AgentToolCallRecord[];
}

export type StopReason = 'answer' | 'max_steps' | 'budget' | 'error';

export interface AgentTranscript {
  turnId: string;
  prompt: string;
  steps: AgentStep[];
  finalAnswer: string;
  stoppedBy: StopReason;
  error?: string;
  usage: LlmUsage;
  provider: string;
  model: string;
  durationMs: number;
}

export const DEFAULT_MAX_STEPS = 8;
/** Tool output fed back to the model is capped so one large response can't eat the budget. */
export const RESULT_CHARS = 4000;

export const AGENT_SYSTEM_PROMPT = [
  'You are an AI assistant completing a user request with the tools provided.',
  'Call tools when they are needed to answer; do not invent identifiers, look them up.',
  'Use only the tools listed. If no tool fits, or a call fails, say so plainly.',
  'When you have what you need, answer the user concisely in plain language.',
].join(' ');

function resultText(r: ExecResult): string {
  const payload = r.ok ? r.body : { error: r.error ?? 'call failed', status: r.status, body: r.body };
  let text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  if (text === undefined) text = '';
  return text.length > RESULT_CHARS ? `${text.slice(0, RESULT_CHARS)}… (truncated)` : text;
}

export async function runAgent(opts: {
  llm: LlmClient;
  prompt: string;
  tools: AgentTool[];
  execute: Executor;
  maxSteps?: number;
  system?: string;
}): Promise<AgentTranscript> {
  const started = Date.now();
  const turnId = randomUUID();
  const maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS;
  const byName = new Map(opts.tools.map((t) => [t.name, t]));
  const llmTools: LlmTool[] = opts.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
  const messages: LlmMessage[] = [{ role: 'user', content: opts.prompt }];
  const steps: AgentStep[] = [];
  const usage: LlmUsage = { inputTokens: 0, outputTokens: 0 };
  let finalAnswer = '';
  let stoppedBy: StopReason = 'max_steps';
  let error: string | undefined;

  for (let index = 0; index < maxSteps; index += 1) {
    let res;
    const stepStarted = Date.now();
    try {
      res = await opts.llm.chat({ system: opts.system ?? AGENT_SYSTEM_PROMPT, messages, tools: llmTools, maxTokens: 1024 });
    } catch (e) {
      stoppedBy = e instanceof LlmError && e.code === 'llm_budget_exceeded' ? 'budget' : 'error';
      error = e instanceof Error ? e.message : String(e);
      logger.warn({ msg: 'agent.step_failed', turn_id: turnId, step: index, stopped_by: stoppedBy, error });
      break;
    }
    logger.debug({
      msg: 'agent.step', turn_id: turnId, step: index, duration_ms: Date.now() - stepStarted,
      tool_calls: res.toolCalls.length, stop_reason: res.stopReason,
    });
    usage.inputTokens += res.usage.inputTokens;
    usage.outputTokens += res.usage.outputTokens;
    const step: AgentStep = { index, text: res.text, toolCalls: [] };
    steps.push(step);
    if (res.toolCalls.length === 0) {
      finalAnswer = res.text;
      stoppedBy = 'answer';
      break;
    }
    messages.push({ role: 'assistant', content: res.text, toolCalls: res.toolCalls });
    for (const call of res.toolCalls) {
      const tool = byName.get(call.name) ?? null;
      const result: ExecResult = tool
        ? await opts.execute(call, tool, { turnId, step: index, prompt: opts.prompt }).catch((e) => ({
          ok: false, body: null, error: e instanceof Error ? e.message : String(e), latencyMs: 0,
        }))
        : { ok: false, body: null, error: `Unknown tool "${call.name}"`, latencyMs: 0 };
      step.toolCalls.push({ id: call.id, name: call.name, args: call.args, known: !!tool, result });
      messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: resultText(result), isError: !result.ok });
    }
  }

  // DP-05: the transcript is stored evidence and shown in the console.
  const redacted = redactValue({ prompt: opts.prompt, steps, finalAnswer }) as {
    prompt: string; steps: AgentStep[]; finalAnswer: string;
  };
  logger.info({
    msg: 'agent.turn', turn_id: turnId, duration_ms: Date.now() - started,
    steps: steps.length, stopped_by: stoppedBy,
    tool_calls: steps.reduce((n, s) => n + s.toolCalls.length, 0),
    input_tokens: usage.inputTokens, output_tokens: usage.outputTokens,
  });
  return {
    turnId,
    prompt: redacted.prompt,
    steps: redacted.steps,
    finalAnswer: redacted.finalAnswer,
    stoppedBy,
    ...(error ? { error } : {}),
    usage,
    provider: opts.llm.provider,
    model: opts.llm.model,
    durationMs: Date.now() - started,
  };
}

/** Every tool call across a transcript, in order. */
export function allCalls(t: Pick<AgentTranscript, 'steps'>): AgentToolCallRecord[] {
  return t.steps.flatMap((s) => s.toolCalls);
}
