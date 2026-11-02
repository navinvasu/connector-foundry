// LLM seam entry point: config → client, a per-run token budget, and JSON
// extraction for structured answers.
//
// Environment contract (D-88):
//   CF_LLM_PROVIDER   bedrock | openai_compatible   (unset → LLM features answer 503)
//   CF_LLM_MODEL      e.g. us.amazon.nova-2-lite-v1:0 (bedrock) or muse-spark-1.3
//   CF_LLM_BASE_URL   openai_compatible only, e.g. https://api.meta.ai/v1
//   CF_LLM_API_KEY    openai_compatible only
//   CF_LLM_REGION     bedrock region (default AWS_REGION, else us-east-1)
//   CF_LLM_MAX_TOKENS_PER_RUN  token cap for one generate / eval / playground run (default 60000)

import { BedrockClient } from './bedrock.js';
import { OpenAiCompatibleClient } from './openai-compatible.js';
import type { ChatRequest, ChatResponse, LlmClient, LlmUsage } from './types.js';
import { LlmError } from './types.js';
import { logger } from '../logger.js';

export * from './types.js';

export function llmFromEnv(env: NodeJS.ProcessEnv = process.env): LlmClient | null {
  const provider = env.CF_LLM_PROVIDER?.trim();
  const model = env.CF_LLM_MODEL?.trim();
  if (!provider || !model) return null;
  if (provider === 'bedrock') {
    return new BedrockClient(model, env.CF_LLM_REGION?.trim() || env.AWS_REGION?.trim() || 'us-east-1');
  }
  if (provider === 'openai_compatible') {
    const baseUrl = env.CF_LLM_BASE_URL?.trim();
    const key = env.CF_LLM_API_KEY?.trim();
    if (!baseUrl || !key) return null;
    return new OpenAiCompatibleClient(model, baseUrl, key);
  }
  return null;
}

let override: LlmClient | null | undefined;

/** The configured client, or null when none is configured. */
export function currentLlm(): LlmClient | null {
  return override !== undefined ? override : llmFromEnv();
}

/** The configured client, or a 503-shaped error. Tests swap it with setLlmClient. */
export function requireLlm(): LlmClient {
  const client = currentLlm();
  if (!client) {
    throw new LlmError('No language model is configured (CF_LLM_PROVIDER / CF_LLM_MODEL).', 'llm_not_configured');
  }
  return client;
}

/** Test seam: inject a scripted client (null = unconfigured, undefined = back to env). */
export function setLlmClient(client: LlmClient | null | undefined): void {
  override = client;
}

export function maxTokensPerRun(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.CF_LLM_MAX_TOKENS_PER_RUN);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 60_000;
}

/**
 * Wraps a client with a token cap shared by every call in one run, so a
 * runaway agent loop or a large project can't spend past the budget.
 */
export class BudgetedLlm implements LlmClient {
  readonly usage: LlmUsage = { inputTokens: 0, outputTokens: 0 };

  constructor(private readonly inner: LlmClient, readonly limit: number = maxTokensPerRun()) {}

  get provider() { return this.inner.provider; }
  get model() { return this.inner.model; }
  get spent() { return this.usage.inputTokens + this.usage.outputTokens; }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    if (this.spent >= this.limit) {
      throw new LlmError(`Token budget of ${this.limit} for this run is spent.`, 'llm_budget_exceeded');
    }
    const res = await this.inner.chat(req);
    this.usage.inputTokens += res.usage.inputTokens;
    this.usage.outputTokens += res.usage.outputTokens;
    return res;
  }
}

/**
 * Stop reasons that mean the model was cut off by the output cap, not by a
 * completed answer — the usual cause of unparseable JSON. OpenAI uses
 * `length`; Bedrock Converse uses `max_tokens`.
 */
export function truncatedStopReason(reason: string | null | undefined): boolean {
  const r = String(reason ?? '').trim().toLowerCase();
  return r === 'length' || r === 'max_tokens';
}

const SNIPPET_CHARS = 500;

/**
 * The first JSON object or array in a model's text answer (models wrap JSON
 * in prose or ``` fences). Throws llm_bad_output when there is none. The
 * failure is logged with a redacted head/tail snippet (fields are
 * DP-05-redacted on emit) so a bad completion can be diagnosed after the
 * fact — the raw text is otherwise discarded.
 */
export function extractJson<T = unknown>(text: string): T {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [fenced?.[1], text];
  for (const c of candidates) {
    if (!c) continue;
    const start = c.search(/[[{]/);
    if (start < 0) continue;
    const open = c[start];
    const close = open === '{' ? '}' : ']';
    const end = c.lastIndexOf(close);
    if (end <= start) continue;
    try {
      return JSON.parse(c.slice(start, end + 1)) as T;
    } catch { /* try the next candidate */ }
  }
  logger.warn({
    msg: 'llm.extract_json_failed',
    text_len: text.length,
    head: text.slice(0, SNIPPET_CHARS),
    tail: text.length > SNIPPET_CHARS ? text.slice(-SNIPPET_CHARS) : undefined,
  });
  throw new LlmError('The model did not return valid JSON.', 'llm_bad_output');
}
