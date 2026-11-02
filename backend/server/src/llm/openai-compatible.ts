// OpenAI-compatible adapter (Chat Completions + function tools). Serves Meta
// Muse Spark (https://api.meta.ai/v1, muse-spark-1.3) and any other
// provider that speaks the same wire format. The key comes from config
// (SSM on the hosted stack) and never appears in errors or logs.

import type { ChatRequest, ChatResponse, LlmClient, LlmMessage, LlmToolCall } from './types.js';
import { LlmError } from './types.js';
import { logger } from '../logger.js';

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) =>
  Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

export function toOpenAiMessages(system: string | undefined, messages: LlmMessage[]): any[] {
  const out: any[] = system ? [{ role: 'system', content: system }] : [];
  for (const m of messages) {
    if (m.role === 'user') out.push({ role: 'user', content: m.content });
    else if (m.role === 'assistant') {
      out.push({
        role: 'assistant',
        content: m.content || null,
        ...(m.toolCalls && m.toolCalls.length > 0
          ? {
            tool_calls: m.toolCalls.map((c) => ({
              id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) },
            })),
          }
          : {}),
      });
    } else {
      out.push({ role: 'tool', tool_call_id: m.toolCallId, content: m.content });
    }
  }
  return out;
}

function parseArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  try {
    const v = JSON.parse(String(raw ?? '{}'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

export class OpenAiCompatibleClient implements LlmClient {
  readonly provider = 'openai_compatible';

  constructor(
    readonly model: string,
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike,
    private readonly timeoutMs = 60_000,
  ) {}

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const started = Date.now();
    const body = {
      model: this.model,
      messages: toOpenAiMessages(req.system, req.messages),
      max_tokens: req.maxTokens ?? 1024,
      temperature: req.temperature ?? 0,
      ...(req.tools && req.tools.length > 0
        ? {
          tools: req.tools.map((t) => ({
            type: 'function',
            function: { name: t.name, description: t.description || t.name, parameters: t.inputSchema },
          })),
        }
        : {}),
    };
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await this.fetchImpl(`${this.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      logger.warn({
        msg: 'llm.chat_failed', provider: this.provider, model: this.model,
        duration_ms: Date.now() - started, error: e instanceof Error ? e.message : String(e),
      });
      throw new LlmError(`${this.model}: ${e instanceof Error ? e.message : String(e)}`, 'llm_upstream_error');
    }
    const text = await res.text();
    if (!res.ok) {
      logger.warn({
        msg: 'llm.chat_failed', provider: this.provider, model: this.model,
        duration_ms: Date.now() - started, status: res.status, body_head: text.slice(0, 200),
      });
      throw new LlmError(`${this.model}: HTTP ${res.status} ${text.slice(0, 200)}`, 'llm_upstream_error');
    }
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      throw new LlmError(`${this.model}: response was not JSON`, 'llm_bad_output');
    }
    const choice = json?.choices?.[0] ?? {};
    const msg = choice.message ?? {};
    const toolCalls: LlmToolCall[] = (msg.tool_calls ?? []).map((c: any, i: number) => ({
      id: String(c.id ?? `call_${i}`),
      name: String(c.function?.name ?? ''),
      args: parseArgs(c.function?.arguments),
    }));
    const out = {
      text: typeof msg.content === 'string' ? msg.content : '',
      toolCalls,
      usage: { inputTokens: json?.usage?.prompt_tokens ?? 0, outputTokens: json?.usage?.completion_tokens ?? 0 },
      stopReason: String(choice.finish_reason ?? 'stop'),
      provider: this.provider,
      model: this.model,
    };
    logger.info({
      msg: 'llm.chat', provider: this.provider, model: this.model,
      duration_ms: Date.now() - started,
      input_tokens: out.usage.inputTokens, output_tokens: out.usage.outputTokens,
      text_len: out.text.length, tool_calls: out.toolCalls.length,
      stop_reason: out.stopReason, max_tokens: body.max_tokens,
    });
    return out;
  }
}
