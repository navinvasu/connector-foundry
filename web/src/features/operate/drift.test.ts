import { describe, it, expect } from 'vitest';
import type { DriftAlertRow, DriftCheckRow } from '../../data/api';
import {
  canTriggerDriftCheck, scenarioLabel, timeAgo, alertFailingLabels, driftCheckSummaryLine,
} from './drift';

const now = new Date('2026-10-05T12:00:00.000Z');

function check(over: Partial<DriftCheckRow> = {}): DriftCheckRow {
  return {
    id: 'dc-1', project_id: 'p1', release_id: 'rel-1', trigger: 'schedule',
    status: 'succeeded', error: null,
    summary: { tools_checked: 3, tools_passed: 3, tools_failed: [], tools_skipped: [] },
    started_at: '2026-10-05T11:30:00.000Z', finished_at: '2026-10-05T11:31:00.000Z',
    ...over,
  };
}

describe('canTriggerDriftCheck', () => {
  it('allows owner/editor, denies viewer/unknown', () => {
    expect(canTriggerDriftCheck('owner')).toBe(true);
    expect(canTriggerDriftCheck('editor')).toBe(true);
    expect(canTriggerDriftCheck('viewer')).toBe(false);
    expect(canTriggerDriftCheck(null)).toBe(false);
  });
});

describe('scenarioLabel', () => {
  it('labels the two contract scenarios, passes others through', () => {
    expect(scenarioLabel('happy_path_2xx_json')).toBe('happy-path 2xx');
    expect(scenarioLabel('missing_params_handled')).toBe('missing-params handling');
    expect(scenarioLabel('custom_x')).toBe('custom_x');
  });
});

describe('timeAgo', () => {
  it('renders minutes, hours, and days', () => {
    expect(timeAgo('2026-10-05T11:57:00.000Z', now)).toBe('3m ago');
    expect(timeAgo('2026-10-05T10:00:00.000Z', now)).toBe('2h ago');
    expect(timeAgo('2026-10-03T12:00:00.000Z', now)).toBe('2d ago');
    expect(timeAgo('2026-10-05T12:00:30.000Z', now)).toBe('just now');
  });
});

describe('alertFailingLabels', () => {
  it('maps evidence scenarios to labels', () => {
    const alert = {
      evidence: { failed_scenarios: ['happy_path_2xx_json', 'missing_params_handled'] },
    } as DriftAlertRow;
    expect(alertFailingLabels(alert)).toEqual(['happy-path 2xx', 'missing-params handling']);
  });

  it('tolerates missing evidence', () => {
    expect(alertFailingLabels({ evidence: null } as DriftAlertRow)).toEqual([]);
  });
});

describe('driftCheckSummaryLine', () => {
  it('summarizes pass/fail/skip counts', () => {
    expect(driftCheckSummaryLine(check())).toBe('3/3 passed');
    expect(driftCheckSummaryLine(check({
      summary: {
        tools_checked: 3, tools_passed: 1,
        tools_failed: [{ tool_id: 't1', tool_name: 'getX' }],
        tools_skipped: [{ tool_id: 't2', tool_name: 'makeY' }],
      },
    }))).toBe('1/3 passed · 1 failing · 1 skipped');
  });

  it('handles running, failed, and no-release states', () => {
    expect(driftCheckSummaryLine(check({ status: 'running' }))).toBe('check running…');
    expect(driftCheckSummaryLine(check({ status: 'failed' }))).toBe('check failed to run');
    expect(driftCheckSummaryLine(check({ summary: { status: 'no_prod_release', tools_checked: 0, tools_passed: 0, tools_failed: [], tools_skipped: [] } })))
      .toBe('no prod release to check');
  });
});
