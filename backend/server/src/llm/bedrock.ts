// Bedrock adapter (Converse API). Credentials come from the SDK's default
// chain: the EC2 instance role on the hosted stack, a local AWS profile in
// development. No API key is stored.

import type { ChatRequest, ChatResponse, LlmClient, LlmMessage, LlmToolCall } from './types.js';
import { LlmError } from './types.js';
import { logger } from '../logger.js';

/** The subset of BedrockRuntimeClient.send this adapter uses (injectable for tests). */
export type ConverseSend = (input: Record<string, unknown>) => Promise<any>;

async function defaultSend(region: string): Promise<ConverseSend> {
  const mod = await import('@aws-sdk/client-bedrock-runtime');
  const client = new mod.BedrockRuntimeClient({ region });
  return (input) => client.send(new mod.ConverseCommand(input as any));
}

/**
 * Converse wants strictly alternating user/assistant turns, with tool
 * results carried as user-turn content blocks. Consecutive same-role
 * messages (several tool results in a row) are merged into one turn.
 */
export function toConverseMessages(messages: LlmMessage[]): Array<{ role: 'user' | 'assistant'; content: any[] }> {
  const out: Array<{ role: 'user' | 'assistant'; content: any[] }> = [];
  const push = (role: 'user' | 'assistant', blocks: any[]) => {
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  };
  for (const m of messages) {
    if (m.role === 'user') push('user', [{ text: m.content }]);
    else if (m.role === 'assistant') {
      const blocks: any[] = [];
      if (m.content) blocks.push({ text: m.content });
      for (const c of m.toolCalls ?? []) blocks.push({ toolUse: { toolUseId: c.id, name: c.name, input: c.args } });
      push('assistant', blocks.length > 0 ? blocks : [{ text: ' ' }]);
    } else {
      push('user', [{
        toolResult: {
          toolUseId: m.toolCallId,
          content: [{ text: m.content || '(empty result)' }],
          ...(m.isError ? { status: 'error' } : {}),
        },
      }]);
    }
  }
  return out;
}

export class BedrockClient implements LlmClient {
  readonly provider = 'bedrock';
  private sendP: Promise<ConverseSend> | null;

  constructor(readonly model: string, private readonly region: string, send?: ConverseSend) {
    this.sendP = send ? Promise.resolve(send) : null;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    if (!this.sendP) this.sendP = defaultSend(this.region);
    const send = await this.sendP;
    const started = Date.now();
    const input: Record<string, unknown> = {
      modelId: this.model,
      messages: toConverseMessages(req.messages),
      inferenceConfig: { maxTokens: req.maxTokens ?? 1024, temperature: req.temperature ?? 0 },
      ...(req.system ? { system: [{ text: req.system }] } : {}),
      ...(req.tools && req.tools.length > 0
        ? {
          toolConfig: {
            tools: req.tools.map((t) => ({
              toolSpec: { name: t.name, description: t.description || t.name, inputSchema: { json: t.inputSchema } },
            })),
          },
        }
        : {}),
    };
    let res: any;
    try {
      res = await send(input);
    } catch (e) {
      logger.warn({
        msg: 'llm.chat_failed', provider: this.provider, model: this.model,
        duration_ms: Date.now() - started, error: e instanceof Error ? e.message : String(e),
      });
      throw new LlmError(`Bedrock ${this.model}: ${e instanceof Error ? e.message : String(e)}`, 'llm_upstream_error');
    }
    const blocks: any[] = res?.output?.message?.content ?? [];
    const text = blocks.filter((b) => typeof b.text === 'string').map((b) => b.text).join('');
    const toolCalls: LlmToolCall[] = blocks
      .filter((b) => b.toolUse)
      .map((b) => ({ id: String(b.toolUse.toolUseId), name: String(b.toolUse.name), args: (b.toolUse.input ?? {}) as Record<string, unknown> }));
    const out = {
      text,
      toolCalls,
      usage: { inputTokens: res?.usage?.inputTokens ?? 0, outputTokens: res?.usage?.outputTokens ?? 0 },
      stopReason: String(res?.stopReason ?? 'end_turn'),
      provider: this.provider,
      model: this.model,
    };
    logger.info({
      msg: 'llm.chat', provider: this.provider, model: this.model,
      duration_ms: Date.now() - started,
      input_tokens: out.usage.inputTokens, output_tokens: out.usage.outputTokens,
      text_len: out.text.length, tool_calls: out.toolCalls.length,
      stop_reason: out.stopReason, max_tokens: (input.inferenceConfig as any)?.maxTokens ?? null,
    });
    return out;
  }
}
