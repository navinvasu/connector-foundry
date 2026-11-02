import { describe, expect, it } from 'vitest';
import { SMOKE_PROJECT_NAME, SMOKE_TARGETS, smokeResetIds } from './smoke-reset.js';

describe('smoke project reset', () => {
  it('always uses the fixed smoke project name', () => {
    expect(SMOKE_PROJECT_NAME).toBe('Test - Twelve Data');
  });

  it('runs every connector target, including Meta Muse', () => {
    expect(SMOKE_TARGETS).toEqual(['mcp', 'openai', 'muse']);
  });

  it('finds every existing project carrying the smoke name for deletion', () => {
    expect(smokeResetIds([
      { id: 'old-1', name: 'Test - Twelve Data' },
      { id: 'other', name: 'Something else' },
      { id: 'old-2', name: 'Test - Twelve Data' },
    ])).toEqual(['old-1', 'old-2']);
  });

  it('deletes nothing when no project carries the smoke name', () => {
    expect(smokeResetIds([{ id: 'a', name: 'Review Verify' }])).toEqual([]);
    expect(smokeResetIds([])).toEqual([]);
  });
});
