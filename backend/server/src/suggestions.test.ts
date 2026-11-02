import { describe, it, expect } from 'vitest';
import { proposeSuggestions, withParamDescription, type ToolForSuggestions } from './suggestions.js';
import type { LlmClient } from './llm/index.js';

const answerWith = (text: string): LlmClient => ({
  provider: 'fake', model: 'f',
  chat: async () => ({ text, toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'end', provider: 'fake', model: 'f' }),
});

const tools: ToolForSuggestions[] = [{
  id: 't1', name: 'searchItems', description: 'Search.', eligible_use: null, ineligible_use: null,
  input_schema: JSON.stringify({ type: 'object', properties: { q: { type: 'string', description: 'Query' } } }),
}];
const evidence = [{ ref: 'agent:a1', kind: 'agent_failure' as const, summary: 'picked the wrong tool' }];

describe('proposeSuggestions', () => {
  it('keeps edits to real tools/fields/params, with before text and known evidence refs', async () => {
    const llm = answerWith(JSON.stringify([
      { tool: 'searchItems', field: 'description', after: 'Full-text search over items by keyword.', rationale: 'r', evidence: ['agent:a1', 'made:up'] },
      { tool: 'searchItems', field: 'param_description', param: 'q', after: 'Keywords, e.g. "red shoes".', rationale: 'r', evidence: [] },
      { tool: 'searchItems', field: 'param_description', param: 'nope', after: 'x', rationale: 'r' },
      { tool: 'ghost', field: 'description', after: 'x' },
      { tool: 'searchItems', field: 'input_schema', after: 'x' },
      { tool: 'searchItems', field: 'description', after: 'Search.' },
    ]));
    const out = await proposeSuggestions(llm, tools, evidence);
    expect(out).toEqual([
      { tool_id: 't1', tool: 'searchItems', field: 'description', param: null, before: 'Search.', after: 'Full-text search over items by keyword.', rationale: 'r', evidence: ['agent:a1'] },
      { tool_id: 't1', tool: 'searchItems', field: 'param_description', param: 'q', before: 'Query', after: 'Keywords, e.g. "red shoes".', rationale: 'r', evidence: [] },
    ]);
  });

  it('asks nothing when there is no evidence', async () => {
    const llm = answerWith('[]');
    expect(await proposeSuggestions(llm, tools, [])).toEqual([]);
  });
});

describe('withParamDescription', () => {
  it('changes only the description of a known argument', () => {
    const s = withParamDescription(tools[0]!.input_schema, 'q', 'Keywords');
    expect(s).toEqual({ type: 'object', properties: { q: { type: 'string', description: 'Keywords' } } });
    expect(() => withParamDescription(tools[0]!.input_schema, 'zzz', 'x')).toThrow(/Unknown argument/);
  });
});
