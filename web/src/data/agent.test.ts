import { describe, it, expect } from 'vitest';
import { agentTaskFlips, compareAgentRuns, suggestionTarget, type AgentResult } from './agent';

const metrics = (success_rate: number, wrong_tool_calls: number) => ({
  status: 'failed' as const,
  metrics: { tasks: 4, success_rate, tool_calls_per_task: 2, wrong_tool_calls, failed_calls: 0, invalid_arg_calls: 0, tokens: 1000 },
});

describe('compareAgentRuns', () => {
  it('marks higher success and fewer wrong calls as improvements', () => {
    const rows = compareAgentRuns(metrics(50, 3), metrics(100, 0));
    expect(rows.find((r) => r.label === 'Task success')).toMatchObject({ before: 50, after: 100, delta: 50, improved: true });
    expect(rows.find((r) => r.label === 'Wrong / invented tool calls')).toMatchObject({ delta: -3, improved: true });
    expect(rows.find((r) => r.label === 'Tokens')).toMatchObject({ delta: 0, improved: null });
  });

  it('has no before side when the previous run had no agent data', () => {
    expect(compareAgentRuns(undefined, metrics(75, 1))[0]).toMatchObject({ before: undefined, after: 75, delta: null });
  });
});

describe('agentTaskFlips', () => {
  const r = (task_id: string, passed: boolean) => ({ task_id, prompt: task_id, passed } as AgentResult);
  it('labels fixed, regressed, unchanged and new tasks', () => {
    const flips = agentTaskFlips([r('a', false), r('b', true), r('c', true)], [r('a', true), r('b', false), r('c', true), r('d', false)]);
    expect(flips.map((f) => [f.taskId, f.change])).toEqual([
      ['a', 'fixed'], ['b', 'regressed'], ['c', 'still_passing'], ['d', 'new'],
    ]);
  });
});

describe('suggestionTarget', () => {
  it('names the edited field in plain words', () => {
    expect(suggestionTarget({ field: 'param_description', param: 'id' })).toBe('argument "id"');
    expect(suggestionTarget({ field: 'eligible_use', param: null })).toBe('when to use');
  });
});
