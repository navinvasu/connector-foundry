import { describe, expect, it } from 'vitest';
import { classifyReviewItem } from './reviewKind';

describe('classifyReviewItem', () => {
  it('keeps risks as actionable blockers', () => {
    expect(classifyReviewItem('risk', 'HOST')).toEqual({ severity: 'blocker', actionable: true });
    expect(classifyReviewItem('risk', 'AUTH')).toEqual({ severity: 'blocker', actionable: true });
  });

  it('treats AUTH and ERROR findings as informational (no user resolution)', () => {
    expect(classifyReviewItem('ambiguity', 'AUTH')).toEqual({ severity: 'info', actionable: false });
    expect(classifyReviewItem('ambiguity', 'ERROR')).toEqual({ severity: 'info', actionable: false });
    expect(classifyReviewItem('ambiguity', 'auth').severity).toBe('info');
  });

  it('keeps other ambiguities as actionable warnings', () => {
    expect(classifyReviewItem('ambiguity', 'SCHEMA')).toEqual({ severity: 'warning', actionable: true });
    expect(classifyReviewItem('ambiguity', 'EFFECT')).toEqual({ severity: 'warning', actionable: true });
    expect(classifyReviewItem('ambiguity', '')).toEqual({ severity: 'warning', actionable: true });
  });
});
