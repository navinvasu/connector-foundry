import { describe, it, expect } from 'vitest';
import { BedrockClient, toConverseMessages } from './bedrock.js';
import { OpenAiCompatibleClient, toOpenAiMessages } from './openai-compatible.js';
import { BudgetedLlm, extractJson, truncatedStopReason, llmFromEnv, LlmError, type LlmClient, type LlmMessage } from './index.js';
import { logger } from '../logger.js';

const convo: LlmMessage[] = [
  { role: 'user', content: 'Find order 42' },
  { role: 'assistant', content: '', toolCalls: [{ id: 't1', name: 'getOrder', args: { id: 42 } }, { id: 't2', name: 'getUser', args: {} }] },
  { role: 'tool', toolCallId: 't1', name: 'getOrder', content: '{"status":"shipped"}' },
  { role: 'tool', toolCallId: 't2', name: 'getUser', content: 'boom', isError: true },
];

describe('Bedrock Converse mapping', () => {
  it('merges consecutive tool results into one user turn', () => {
    const m = toConverseMessages(convo);
    expect(m.map((x) => x.role)).toEqual(['user', 'assistant', 'user']);
    expect(m[1]!.content).toEqual([
      { toolUse: { toolUseId: 't1', name: 'getOrder', input: { id: 42 } } },
      { toolUse: { toolUseId: 't2', name: 'getUser', input: {} } },
    ]);
    expect(m[2]!.content[1].toolResult).toMatchObject({ toolUseId: 't2', status: 'error' });
  });

  it('sends tools + system and reads text, tool calls and usage', async () => {
    let sent: any;
    const client = new BedrockClient('us.amazon.nova-2-lite-v1:0', 'us-east-1', async (input) => {
      sent = input;
      return {
        output: { message: { content: [{ text: 'Looking it up' }, { toolUse: { toolUseId: 'x', name: 'getOrder', input: { id: 1 } } }] } },
        usage: { inputTokens: 10, outputTokens: 5 },
        stopReason: 'tool_use',
      };
    });
    const res = await client.chat({
      system: 'be brief', messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 'getOrder', description: 'Get an order', inputSchema: { type: 'object' } }],
    });
    expect(sent.modelId).toBe('us.amazon.nova-2-lite-v1:0');
    expect(sent.system).toEqual([{ text: 'be brief' }]);
    expect(sent.toolConfig.tools[0].toolSpec.inputSchema).toEqual({ json: { type: 'object' } });
    expect(res).toMatchObject({
      text: 'Looking it up', toolCalls: [{ id: 'x', name: 'getOrder', args: { id: 1 } }],
      usage: { inputTokens: 10, outputTokens: 5 }, stopReason: 'tool_use', provider: 'bedrock',
    });
  });

  it('wraps SDK failures as llm_upstream_error (502)', async () => {
    const client = new BedrockClient('m', 'us-east-1', async () => { throw new Error('AccessDenied'); });
    await expect(client.chat({ messages: [{ role: 'user', content: 'x' }] })).rejects.toMatchObject({ code: 'llm_upstream_error', status: 502 });
  });
});

describe('OpenAI-compatible mapping (Muse Spark)', () => {
  it('maps assistant tool calls and tool results', () => {
    const m = toOpenAiMessages('sys', convo);
    expect(m[0]).toEqual({ role: 'system', content: 'sys' });
    expect(m[2].tool_calls[0]).toEqual({ id: 't1', type: 'function', function: { name: 'getOrder', arguments: '{"id":42}' } });
    expect(m[3]).toEqual({ role: 'tool', tool_call_id: 't1', content: '{"status":"shipped"}' });
  });

  it('posts to /chat/completions with the bearer key and parses tool calls', async () => {
    let url = ''; let init: any;
    const client = new OpenAiCompatibleClient('muse-spark-1.3', 'https://api.meta.ai/v1/', 'k-123', async (u, i) => {
      url = u; init = i;
      return {
        ok: true, status: 200,
        text: async () => JSON.stringify({
          choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{ id: 'c1', function: { name: 'getOrder', arguments: '{"id":7}' } }] } }],
          usage: { prompt_tokens: 3, completion_tokens: 4 },
        }),
      };
    });
    const res = await client.chat({ messages: [{ role: 'user', content: 'hi' }], tools: [{ name: 'getOrder', description: '', inputSchema: { type: 'object' } }] });
    expect(url).toBe('https://api.meta.ai/v1/chat/completions');
    expect(init.headers.authorization).toBe('Bearer k-123');
    expect(JSON.parse(init.body).tools[0].function.name).toBe('getOrder');
    expect(res).toMatchObject({ toolCalls: [{ id: 'c1', name: 'getOrder', args: { id: 7 } }], usage: { inputTokens: 3, outputTokens: 4 } });
  });

  it('never echoes the key on HTTP errors', async () => {
    const client = new OpenAiCompatibleClient('m', 'https://x', 'secret-key', async () => ({ ok: false, status: 401, text: async () => 'bad key' }));
    const err = await client.chat({ messages: [{ role: 'user', content: 'x' }] }).catch((e) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect(String(err.message)).not.toContain('secret-key');
  });
});

describe('config, budget, JSON extraction', () => {
  it('builds clients from env and stays null when incomplete', () => {
    expect(llmFromEnv({})).toBeNull();
    expect(llmFromEnv({ CF_LLM_PROVIDER: 'bedrock', CF_LLM_MODEL: 'm' })?.provider).toBe('bedrock');
    expect(llmFromEnv({ CF_LLM_PROVIDER: 'openai_compatible', CF_LLM_MODEL: 'm' })).toBeNull();
    expect(llmFromEnv({ CF_LLM_PROVIDER: 'openai_compatible', CF_LLM_MODEL: 'm', CF_LLM_BASE_URL: 'https://x', CF_LLM_API_KEY: 'k' })?.provider)
      .toBe('openai_compatible');
  });

  it('stops a run once the token budget is spent', async () => {
    const inner: LlmClient = {
      provider: 'fake', model: 'f',
      chat: async () => ({ text: 'ok', toolCalls: [], usage: { inputTokens: 60, outputTokens: 50 }, stopReason: 'end', provider: 'fake', model: 'f' }),
    };
    const b = new BudgetedLlm(inner, 100);
    await b.chat({ messages: [] });
    expect(b.spent).toBe(110);
    await expect(b.chat({ messages: [] })).rejects.toMatchObject({ code: 'llm_budget_exceeded', status: 429 });
  });

  it('extracts JSON from fenced or prose answers', () => {
    expect(extractJson('Here:\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('Sure! [{"x":2}] done')).toEqual([{ x: 2 }]);
    expect(() => extractJson('no json here')).toThrow(LlmError);
  });

  it('names length / max_tokens stop reasons as truncation', () => {
    expect(truncatedStopReason('length')).toBe(true);
    expect(truncatedStopReason('max_tokens')).toBe(true);
    expect(truncatedStopReason('MAX_TOKENS')).toBe(true);
    expect(truncatedStopReason('stop')).toBe(false);
    expect(truncatedStopReason('end_turn')).toBe(false);
    expect(truncatedStopReason(null)).toBe(false);
    expect(truncatedStopReason(undefined)).toBe(false);
  });

  it('logs a redacted snippet when extraction fails', () => {
    const seen: Record<string, unknown>[] = [];
    const orig = logger.warn;
    logger.warn = ((fields: Record<string, unknown>) => { seen.push(fields); }) as typeof logger.warn;
    try {
      expect(() => extractJson('truncated: {"a":1, "b":')).toThrow(LlmError);
    } finally {
      logger.warn = orig;
    }
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ msg: 'llm.extract_json_failed' });
    expect(seen[0]!['text_len']).toBe('truncated: {"a":1, "b":'.length);
    expect(String(seen[0]!['head'])).toContain('{"a":1');
  });
});
