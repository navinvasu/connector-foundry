import { describe, expect, it } from 'vitest';
import { findingRecommendation } from './sources.js';

describe('findingRecommendation (review queue suggested fixes)', () => {
  it('gives a concrete fix for actionable findings', () => {
    expect(findingRecommendation({ code: 'HOST', severity: 'blocker' })).toMatch(/servers.*re-import/);
    expect(findingRecommendation({ code: 'SCHEMA', severity: 'warning' })).toMatch(/description/);
    expect(findingRecommendation({ code: 'EFFECT', severity: 'blocker' })).toMatch(/approve/);
    expect(findingRecommendation({ code: 'EFFECT', severity: 'warning' })).toMatch(/approve/);
  });

  it('marks informational findings as needing no fix (acknowledge, not resolve)', () => {
    expect(findingRecommendation({ code: 'AUTH', severity: 'warning' })).toMatch(/Informational/);
    expect(findingRecommendation({ code: 'ERROR', severity: 'warning' })).toMatch(/Informational/);
  });
});
