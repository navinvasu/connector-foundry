import { describe, it, expect } from 'vitest';
import { runAgent, allCalls, type AgentTool, type Executor } from './runner.js';
import type { ChatRequest, ChatResponse, LlmClient } from '../llm/index.js';
import { LlmError } from '../llm/index.js';

/** A scripted model: each chat() returns the next canned response. */
function scripted(responses: Array<Partial<ChatResponse>>): LlmClient & { requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  let i = 0;
  return {
    provider: 'fake', model: 'fake-1', requests,
    async chat(req) {
      requests.push(JSON.parse(JSON.stringify(req)));
      const r = responses[i++];
      if (!r) throw new LlmError('script exhausted', 'llm_budget_exceeded');
      return { text: '', toolCalls: [], usage: { inputTokens: 10, outputTokens: 5 }, stopReason: 'end', provider: 'fake', model: 'fake-1', ...r };
    },
  };
}

const tools: AgentTool[] = [
  { name: 'getOrder', description: 'Get one order by id', inputSchema: { type: 'object' }, accessClass: 'read' },
];

describe('runAgent', () => {
  it('calls tools, feeds results back, and returns the answer with usage', async () => {
    const llm = scripted([
      { toolCalls: [{ id: 'c1', name: 'getOrder', args: { id: 42 } }] },
      { text: 'Order 42 has shipped.' },
    ]);
    const seen: unknown[] = [];
    const execute: Executor = async (call, tool, ctx) => {
      seen.push({ name: call.name, access: tool?.accessClass, step: ctx.step, prompt: ctx.prompt });
      return { ok: true, status: 200, body: { status: 'shipped' }, latencyMs: 12 };
    };
    const t = await runAgent({ llm, prompt: 'Where is order 42?', tools, execute });
    expect(t.stoppedBy).toBe('answer');
    expect(t.finalAnswer).toBe('Order 42 has shipped.');
    expect(t.usage).toEqual({ inputTokens: 20, outputTokens: 10 });
    expect(seen).toEqual([{ name: 'getOrder', access: 'read', step: 0, prompt: 'Where is order 42?' }]);
    expect(allCalls(t).map((c) => c.name)).toEqual(['getOrder']);
    // The second model turn saw the tool result.
    const last = llm.requests[1]!.messages.at(-1)!;
    expect(last).toMatchObject({ role: 'tool', toolCallId: 'c1', content: '{"status":"shipped"}' });
  });

  it('answers an unknown tool with an error result and records it as not known', async () => {
    const llm = scripted([
      { toolCalls: [{ id: 'c1', name: 'deleteEverything', args: {} }] },
      { text: 'I cannot do that.' },
    ]);
    const t = await runAgent({ llm, prompt: 'x', tools, execute: async () => { throw new Error('must not run'); } });
    expect(allCalls(t)[0]).toMatchObject({ name: 'deleteEverything', known: false, result: { ok: false } });
  });

  it('stops at max steps, and on budget exhaustion', async () => {
    const loop = scripted(Array.from({ length: 5 }, (_, i) => ({ toolCalls: [{ id: `c${i}`, name: 'getOrder', args: {} }] })));
    const t = await runAgent({ llm: loop, prompt: 'x', tools, maxSteps: 3, execute: async () => ({ ok: true, body: {}, latencyMs: 1 }) });
    expect(t.stoppedBy).toBe('max_steps');
    expect(t.steps).toHaveLength(3);

    const broke = scripted([]);
    const b = await runAgent({ llm: broke, prompt: 'x', tools, execute: async () => ({ ok: true, body: {}, latencyMs: 1 }) });
    expect(b.stoppedBy).toBe('budget');
  });

  it('redacts secrets in the stored transcript', async () => {
    const llm = scripted([{ text: 'Your key is sk-live-1234567890abcdefghij' }]);
    const t = await runAgent({ llm, prompt: 'email me at ada@example.com', tools, execute: async () => ({ ok: true, body: {}, latencyMs: 1 }) });
    expect(t.prompt).not.toContain('ada@example.com');
  });
});
