import { describe, it, expect } from 'vitest';
import { formatRunDateTime, outcomeFromSummary, scenarioGuidance } from './evalOutcome';

describe('formatRunDateTime', () => {
  it('formats a real started_at and never renders Invalid Date', () => {
    expect(formatRunDateTime('2026-10-26T17:38:36.476Z')).not.toBe('Invalid Date');
    expect(formatRunDateTime('2026-10-26T17:38:36.476Z')).toMatch(/2026/);
    expect(formatRunDateTime(undefined)).toBe('—');
    expect(formatRunDateTime(null)).toBe('—');
    expect(formatRunDateTime('not-a-date')).toBe('—');
    expect(formatRunDateTime('')).toBe('—');
  });
});

describe('outcomeFromSummary', () => {
  it('maps the backend per-tool outcome (187 found, 6 passed, 181 failed shape)', () => {
    const out = outcomeFromSummary({
      tools: {
        total: 187, passed: 6, failed: 181, passed_tool_ids: ['a'],
        passed_tools: [{ tool_id: 'a', tool_name: 'GetQuote' }],
        failed_tools: [{ tool_id: 'b', tool_name: 'GetBonds', failed_scenarios: 3, categories: ['access_not_allowed'] }],
        failures_by_category: [{ category: 'access_not_allowed', label: 'Not allowed for this API key (403)', tool_count: 120, suggestion: 'Upgrade the plan or exclude the operation.' }],
      },
    });
    expect(out).toMatchObject({ total: 187, passed: 6, failed: 181 });
    expect(out?.failuresByCategory[0].tool_count).toBe(120);
    expect(out?.failedTools[0].tool_name).toBe('GetBonds');
    expect(out?.passedTools).toEqual([{ tool_id: 'a', tool_name: 'GetQuote' }]);
  });

  it('defaults passedTools to empty for runs stored before the passed list', () => {
    const out = outcomeFromSummary({
      tools: { total: 2, passed: 1, failed: 1, passed_tool_ids: ['a'], failed_tools: [], failures_by_category: [] },
    });
    expect(out?.passedTools).toEqual([]);
  });

  it('guides API failures toward the fix, stays quiet on logic failures', () => {
    expect(scenarioGuidance({ statusCode: 401 })).toMatch(/API key/);
    expect(scenarioGuidance({ statusCode: 403 })).toMatch(/rate-limit window/);
    expect(scenarioGuidance({ statusCode: 404 })).toMatch(/placeholder/);
    expect(scenarioGuidance({ statusCode: 429 })).toMatch(/Rate-limited/);
    expect(scenarioGuidance({ statusCode: 503 })).toMatch(/not the connector/);
    expect(scenarioGuidance({ statusCode: null, diagnosis: 'Request failed: timed out' }))
      .toMatch(/timed out or is unreachable/);
    // A custom-scenario assertion failure has no transport advice to add.
    expect(scenarioGuidance({ statusCode: null, diagnosis: 'Expected status 200' })).toBeNull();
    expect(scenarioGuidance({ statusCode: 200 })).toBeNull();
  });

  it('returns null for runs without an outcome (legacy summaries)', () => {
    expect(outcomeFromSummary({ suites: {} })).toBeNull();
    expect(outcomeFromSummary(null)).toBeNull();
    expect(outcomeFromSummary(undefined)).toBeNull();
  });
});
