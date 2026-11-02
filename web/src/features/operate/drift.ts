// TE-03 console helpers: pure display logic for the drift section, kept
// separate from the component so it is unit-testable without a DOM (the
// web suite has no component renderer).

import type { DriftAlertRow, DriftCheckRow } from '../../data/api';

/** Owner/editor may trigger a manual check; viewers are read-only (FE-09: the API is the gate). */
export function canTriggerDriftCheck(callerRole: string | null): boolean {
  return callerRole === 'owner' || callerRole === 'editor';
}

/** Human label for a contract scenario id. */
export function scenarioLabel(scenario: string): string {
  if (scenario === 'happy_path_2xx_json') return 'happy-path 2xx';
  if (scenario === 'missing_params_handled') return 'missing-params handling';
  return scenario;
}

/** "3m ago" style relative time. */
export function timeAgo(iso: string, now: Date = new Date()): string {
  const ms = now.getTime() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return 'just now';
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/** Failing scenarios of an alert, human-labeled. */
export function alertFailingLabels(alert: DriftAlertRow): string[] {
  return (alert.evidence?.failed_scenarios ?? []).map(scenarioLabel);
}

/** One-line summary of the latest check for the section footer. */
export function driftCheckSummaryLine(check: DriftCheckRow): string {
  if (check.status === 'running') return 'check running…';
  if (check.status === 'failed') return 'check failed to run';
  const s = check.summary;
  if (!s || s.status === 'no_prod_release') return 'no prod release to check';
  const parts = [`${s.tools_passed}/${s.tools_checked} passed`];
  if (s.tools_failed.length > 0) parts.push(`${s.tools_failed.length} failing`);
  if (s.tools_skipped.length > 0) parts.push(`${s.tools_skipped.length} skipped`);
  return parts.join(' · ');
}
