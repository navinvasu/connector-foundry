// Passed-only outcome view of an eval run (from run.summary.tools, computed
// by the backend). Pure so the date guard and shape are unit-tested.

export interface FailureCategory {
  category: string;
  label: string;
  tool_count: number;
  suggestion: string;
}

export interface EvalOutcome {
  total: number;
  passed: number;
  failed: number;
  /** Passed tools with names; empty on runs completed before the backend
   *  started storing them (only ids were kept). */
  passedTools: Array<{ tool_id: string; tool_name: string }>;
  failedTools: Array<{ tool_id: string; tool_name: string; failed_scenarios: number; categories: string[] }>;
  failuresByCategory: FailureCategory[];
}

/** Locale string for a run timestamp; '—' instead of "Invalid Date" when
 *  the value is missing or unparseable (eval_runs carries started_at). */
export function formatRunDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
}

/**
 * Actionable next step for a failed scenario, from its upstream status.
 * Returns null when the diagnosis above already says everything (a logic
 * failure, not a transport one) — the panel then shows no extra guidance.
 */
export function scenarioGuidance(s: { statusCode?: number | null; diagnosis?: string }): string | null {
  const code = s.statusCode ?? null;
  if (code === 401) {
    return 'The upstream rejected the credential (401). Check the API key in Tools → Credentials, then re-run — nothing about the connector needs to change.';
  }
  if (code === 403) {
    return 'The upstream refused the call (403) — usually the key\u2019s plan or an exhausted rate-limit window, not the connector. Check the key\u2019s quota, wait for the window to reset (up to an hour for hourly quotas), then re-run.';
  }
  if (code === 404) {
    return 'The upstream has no such resource (404) — the scenario likely used a placeholder id. Approve tools with real argument values, or add a custom scenario with one, then re-run.';
  }
  if (code === 429) {
    return 'Rate-limited (429). Wait for the reset window, avoid back-to-back full evals, then re-run.';
  }
  if (code !== null && code >= 500) {
    return `Upstream error (${code}) — the provider failed, not the connector. Wait a few minutes and re-run.`;
  }
  if (code === null && s.diagnosis && /timed? ?out|no response|not sent|unreachable|request failed/i.test(s.diagnosis)) {
    return 'No upstream answer was recorded — the API timed out or is unreachable. Check it is up, then re-run.';
  }
  return null;
}

export function outcomeFromSummary(summary: any): EvalOutcome | null {
  const t = summary?.tools;
  if (!t || typeof t.total !== 'number') return null;
  return {
    total: t.total,
    passed: t.passed ?? 0,
    failed: t.failed ?? 0,
    passedTools: Array.isArray(t.passed_tools) ? t.passed_tools : [],
    failedTools: Array.isArray(t.failed_tools) ? t.failed_tools : [],
    failuresByCategory: Array.isArray(t.failures_by_category) ? t.failures_by_category : [],
  };
}
