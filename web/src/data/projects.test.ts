import { describe, expect, it } from 'vitest';
import { ENDUSER_AUTH_OPTIONS, TARGET_OPTIONS, UPSTREAM_AUTH_OPTIONS, formatTargets } from './projects';

describe('connector targets (v1: MCP + OpenAI + Meta Muse)', () => {
  it('offers Meta Muse as a selectable target — nothing gated behind v2', () => {
    const muse = TARGET_OPTIONS.find((t) => t.id === 'muse');
    expect(muse).toBeDefined();
    expect(muse?.disabled).not.toBe(true);
    expect(TARGET_OPTIONS.filter((t) => t.disabled)).toEqual([]);
  });

  it('formats the full target set', () => {
    expect(formatTargets(['mcp', 'openai', 'muse'])).toBe('MCP + OpenAI + Meta Muse');
  });
});

describe('project authentication options (demo scope)', () => {
  it('offers API key live and access-token login disabled upstream', () => {
    expect(UPSTREAM_AUTH_OPTIONS.map((o) => o.id)).toEqual(['api_key', 'access_token']);
    expect(UPSTREAM_AUTH_OPTIONS.find((o) => o.id === 'api_key')?.disabled).not.toBe(true);
    const token = UPSTREAM_AUTH_OPTIONS.find((o) => o.id === 'access_token');
    expect(token?.disabled).toBe(true);
    expect(token?.disabledNote).toMatch(/demo/i);
  });

  it('offers gateway keys live and auth-based login disabled for end users', () => {
    expect(ENDUSER_AUTH_OPTIONS.map((o) => o.id)).toEqual(['gateway_key', 'auth_login']);
    expect(ENDUSER_AUTH_OPTIONS.find((o) => o.id === 'gateway_key')?.disabled).not.toBe(true);
    const login = ENDUSER_AUTH_OPTIONS.find((o) => o.id === 'auth_login');
    expect(login?.disabled).toBe(true);
    expect(login?.disabledNote).toMatch(/demo/i);
  });
});
