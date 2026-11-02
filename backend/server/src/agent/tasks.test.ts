import { describe, it, expect } from 'vitest';
import { scoreTranscript, proposeTasks, judgeAnswer, extractTaskObjects } from './tasks.js';
import type { AgentTranscript, AgentTool } from './runner.js';
import type { LlmClient } from '../llm/index.js';

function transcript(calls: Array<{ name: string; known?: boolean; ok?: boolean; status?: number; dryRun?: boolean }>, answer = 'Done.'): AgentTranscript {
  return {
    turnId: 't', prompt: 'p', finalAnswer: answer, stoppedBy: answer ? 'answer' : 'max_steps',
    usage: { inputTokens: 1, outputTokens: 1 }, provider: 'fake', model: 'f', durationMs: 1,
    steps: [{
      index: 0, text: '',
      toolCalls: calls.map((c, i) => ({
        id: `c${i}`, name: c.name, args: {}, known: c.known ?? true,
        result: { ok: c.ok ?? true, status: c.status, body: null, latencyMs: 1, ...(c.dryRun ? { dryRun: true } : {}) },
      })),
    }],
  };
}

const answerWith = (text: string): LlmClient => ({
  provider: 'fake', model: 'f',
  chat: async () => ({ text, toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'end', provider: 'fake', model: 'f' }),
});

describe('scoreTranscript', () => {
  const task = { expected_tools: ['listOrders', 'getOrder'], forbidden_tools: ['cancelOrder'] };

  it('passes when every expected tool ran and nothing forbidden or invented did', () => {
    const s = scoreTranscript(task, transcript([{ name: 'listOrders' }, { name: 'getOrder' }]));
    expect(s.passed).toBe(true);
    expect(s).toMatchObject({ toolCalls: 2, wrongToolCalls: 0, failedCalls: 0 });
  });

  it('fails on a missing expected tool, a forbidden call, or an invented tool', () => {
    const s = scoreTranscript(task, transcript([
      { name: 'listOrders' }, { name: 'cancelOrder', dryRun: true }, { name: 'refundAll', known: false },
    ]));
    expect(s.passed).toBe(false);
    const failed = s.checks.filter((c) => !c.passed).map((c) => c.name);
    expect(failed).toEqual(['expected_tools_called', 'no_forbidden_tools', 'no_unknown_tools']);
    expect(s.wrongToolCalls).toBe(2);
  });

  it('counts 400/422 answers as invalid-argument calls; dry runs are not failures', () => {
    const s = scoreTranscript({ expected_tools: [], forbidden_tools: [] }, transcript([
      { name: 'getOrder', ok: false, status: 422 }, { name: 'getOrder', ok: false, status: 500 }, { name: 'cancelOrder', dryRun: true },
    ]));
    expect(s).toMatchObject({ failedCalls: 2, invalidArgCalls: 1 });
  });

  it('fails an agent that never answered', () => {
    expect(scoreTranscript({ expected_tools: [], forbidden_tools: [] }, transcript([], '')).passed).toBe(false);
  });
});

describe('proposeTasks', () => {
  const tools: AgentTool[] = [
    { name: 'listOrders', description: 'List orders', inputSchema: { type: 'object', properties: { status: {} } }, accessClass: 'read' },
    { name: 'cancelOrder', description: 'Cancel', inputSchema: { type: 'object', properties: {} }, accessClass: 'write' },
  ];

  it('keeps well-formed tasks and drops tool names that do not exist', async () => {
    const llm = answerWith('```json\n[{"prompt":"What did I order last week?","expected_tools":["listOrders","madeUp"],"forbidden_tools":["cancelOrder"],"answer_rubric":"Lists orders"},{"nope":1}]\n```');
    const tasks = await proposeTasks(llm, 'Orders API', tools);
    expect(tasks).toEqual([{
      prompt: 'What did I order last week?', expected_tools: ['listOrders'], forbidden_tools: ['cancelOrder'], answer_rubric: 'Lists orders',
    }]);
  });

  it('retries a non-JSON reply with a repair nudge and succeeds', async () => {
    const seen: string[] = [];
    let calls = 0;
    const llm: LlmClient = {
      provider: 'fake', model: 'f',
      chat: async (req) => {
        calls++;
        seen.push(req.messages.map((m) => m.content).join('\n'));
        const text = calls === 1
          ? 'Sure, here are some tasks for you to consider!'
          : '[{"prompt":"Where is my order?","expected_tools":["listOrders"],"forbidden_tools":[],"answer_rubric":"r"}]';
        return { text, toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'stop', provider: 'fake', model: 'f' };
      },
    };
    const tasks = await proposeTasks(llm, 'Orders API', tools);
    expect(tasks.map((t) => t.prompt)).toEqual(['Where is my order?']);
    expect(calls).toBe(2);
    expect(seen[1]).toContain('not a valid JSON array');
  });

  it('salvages finished tasks out of a truncated reply without another call', async () => {
    let calls = 0;
    const llm: LlmClient = {
      provider: 'fake', model: 'f',
      chat: async () => {
        calls++;
        return {
          text: '[{"prompt":"First task","expected_tools":["listOrders"],"forbidden_tools":[],"answer_rubric":"r"}, {"prompt":"Second ta',
          toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'length', provider: 'fake', model: 'f',
        };
      },
    };
    const tasks = await proposeTasks(llm, 'Orders API', tools);
    expect(tasks.map((t) => t.prompt)).toEqual(['First task']);
    expect(calls).toBe(1);
  });

  it('gives up after three unusable replies and rethrows', async () => {
    let calls = 0;
    const llm: LlmClient = {
      provider: 'fake', model: 'f',
      chat: async () => {
        calls++;
        return { text: 'just some prose, no tasks here', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'stop', provider: 'fake', model: 'f' };
      },
    };
    await expect(proposeTasks(llm, 'Orders API', tools)).rejects.toMatchObject({ code: 'llm_bad_output' });
    expect(calls).toBe(3);
  });
});

describe('extractTaskObjects', () => {
  it('pulls complete objects out of a cut-off array', () => {
    const out = extractTaskObjects('[{"prompt":"A","x":1}, {"prompt":"B","x":');
    expect(out).toEqual([{ prompt: 'A', x: 1 }]);
  });

  it('ignores braces inside quoted strings', () => {
    const out = extractTaskObjects('[{"prompt":"show {braces} here","x":1}] trailing');
    expect(out).toEqual([{ prompt: 'show {braces} here', x: 1 }]);
  });

  it('skips broken spans and returns nothing for prose', () => {
    expect(extractTaskObjects('no json here')).toEqual([]);
    expect(extractTaskObjects('[{"prompt":')).toEqual([]);
  });
});

describe('judgeAnswer', () => {
  it('reads a JSON verdict, and fails closed when the judge is unusable', async () => {
    expect(await judgeAnswer(answerWith('{"pass": true, "reason": "ok"}'), 'q', 'a', 'r')).toMatchObject({ passed: true });
    expect(await judgeAnswer(answerWith('no idea'), 'q', 'a', 'r')).toMatchObject({ passed: false });
  });
});
