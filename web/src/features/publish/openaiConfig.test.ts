import { describe, it, expect } from 'vitest';
import { openAiToolsUrl, gptActionsSpecUrl, gptActionsSetup } from './openaiConfig';

describe('openAiToolsUrl / gptActionsSpecUrl', () => {
  it('builds the per-release artifact URLs with the id encoded', () => {
    expect(openAiToolsUrl('http://localhost:4000', 'r1'))
      .toBe('http://localhost:4000/v1/releases/r1/openai/tools');
    expect(gptActionsSpecUrl('https://api.example.com/', 'rel 1'))
      .toBe('https://api.example.com/v1/releases/rel%201/openai/actions');
  });
});

describe('gptActionsSetup', () => {
  it('names the import URL and the X-API-Key auth without a secret', () => {
    const text = gptActionsSetup('https://api.example.com/v1/releases/r1/openai/actions');
    expect(text).toContain('https://api.example.com/v1/releases/r1/openai/actions');
    expect(text).toContain('X-API-Key');
    expect(text).toContain('<your-gateway-key>');
    expect(text).not.toContain('cf_live_');
  });
});
