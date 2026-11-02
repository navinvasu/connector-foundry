import type { Severity } from './types';

// Review-item classification. Some findings have no user action that could
// resolve them — the spec simply doesn't declare auth schemes (AUTH) or
// error responses (ERROR); the product works around both. Those are
// informational: shown as info, closed by acknowledging, never as warnings
// demanding a resolution. Everything else is actionable and keeps its
// blocker/warning level with a suggested fix.

const INFORMATIONAL_CODES = new Set(['AUTH', 'ERROR']);

export interface ReviewKind {
  severity: Severity;
  /** True when a user action can resolve the item. */
  actionable: boolean;
}

export function classifyReviewItem(kind: string, code: string): ReviewKind {
  if (kind === 'risk') return { severity: 'blocker', actionable: true };
  if (INFORMATIONAL_CODES.has(code.toUpperCase())) {
    return { severity: 'info', actionable: false };
  }
  return { severity: 'warning', actionable: true };
}
