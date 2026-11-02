// EV-05 → EV-06: certification criteria — the pure judge behind the badge.
import { describe, it, expect } from 'vitest';
import {
  evaluateCertification,
  CERTIFICATION_CRITERIA,
  CERTIFICATION_CRITERIA_VERSION,
  type CertificationInput,
} from './certification.js';

function passingInput(over: Partial<CertificationInput> = {}): CertificationInput {
  return {
    runStatus: 'passed',
    suites: {
      contract: { status: 'passed', passed: 2, failed: 0 },
      behavior: { status: 'passed', passed: 1, failed: 0 },
      recovery: { status: 'passed', passed: 1, failed: 0 },
      auth: { status: 'not_tested', reason: 'All evaluated tools require no credentials (credential_mode = none).' },
      safety: { status: 'passed' },
    },
    results: [
      { tool_id: 'tool-1', suite: 'contract', passed: true },
      { tool_id: 'tool-1', suite: 'contract', passed: true },
      { tool_id: 'tool-1', suite: 'behavior', passed: true },
      { tool_id: 'tool-1', suite: 'recovery', passed: true },
    ],
    tools: [{ id: 'tool-1', credential_mode: 'none', effect_classes: ['read_only'] }],
    ...over,
  };
}

function check(verdict: ReturnType<typeof evaluateCertification>, id: string) {
  const c = verdict.checks.find((x) => x.id === id);
  expect(c, `check ${id} exists`).toBeDefined();
  return c!;
}

describe('evaluateCertification (EV-05 → EV-06, criteria v2)', () => {
  it('publishes the criteria the badge is judged against', () => {
    expect(CERTIFICATION_CRITERIA_VERSION).toBe('v2');
    expect(CERTIFICATION_CRITERIA.map((c) => c.id)).toEqual([
      'run_passed', 'contract_suite', 'behavior_suite', 'recovery_suite',
      'auth_suite', 'safety_verified', 'tool_coverage',
    ]);
    for (const c of CERTIFICATION_CRITERIA) {
      expect(c.label.length).toBeGreaterThan(0);
      expect(c.description.length).toBeGreaterThan(0);
    }
  });

  it('certifies a clean read-only run with full coverage', () => {
    const v = evaluateCertification(passingInput());
    expect(v.certified).toBe(true);
    expect(v.criteria_version).toBe('v2');
    expect(v.checks).toHaveLength(7);
    expect(v.checks.every((c) => c.status === 'pass')).toBe(true);
    expect(check(v, 'auth_suite').detail).toMatch(/Not required/);
  });

  it('certifies an api_key run whose credential was accepted', () => {
    const v = evaluateCertification(passingInput({
      suites: {
        contract: { status: 'passed', passed: 2, failed: 0 },
        behavior: { status: 'passed', passed: 1, failed: 0 },
        recovery: { status: 'passed', passed: 1, failed: 0 },
        auth: { status: 'passed', passed: 1, failed: 0 },
        safety: { status: 'passed' },
      },
      results: [
        { tool_id: 'tool-1', suite: 'contract', passed: true },
        { tool_id: 'tool-1', suite: 'contract', passed: true },
        { tool_id: 'tool-1', suite: 'behavior', passed: true },
        { tool_id: 'tool-1', suite: 'recovery', passed: true },
        { tool_id: 'tool-1', suite: 'auth', passed: true },
      ],
      tools: [{ id: 'tool-1', credential_mode: 'api_key', effect_classes: ['read_only'] }],
    }));
    expect(v.certified).toBe(true);
    expect(check(v, 'auth_suite').status).toBe('pass');
  });

  it('blocks when the run did not pass overall', () => {
    const v = evaluateCertification(passingInput({ runStatus: 'failed' }));
    expect(v.certified).toBe(false);
    expect(check(v, 'run_passed').status).toBe('fail');
    expect(check(v, 'run_passed').detail).toContain('"failed"');
  });

  it('blocks when a required suite failed', () => {
    const v = evaluateCertification(passingInput({
      suites: {
        ...passingInput().suites,
        recovery: { status: 'failed', passed: 0, failed: 1 },
      },
      results: [
        { tool_id: 'tool-1', suite: 'contract', passed: true },
        { tool_id: 'tool-1', suite: 'behavior', passed: true },
        { tool_id: 'tool-1', suite: 'recovery', passed: false },
      ],
    }));
    expect(v.certified).toBe(false);
    expect(check(v, 'recovery_suite').status).toBe('fail');
  });

  it('never trusts the summary: a failed result blocks despite a passed suite summary', () => {
    const v = evaluateCertification(passingInput({
      results: [
        { tool_id: 'tool-1', suite: 'contract', passed: true },
        { tool_id: 'tool-1', suite: 'contract', passed: false },
        { tool_id: 'tool-1', suite: 'behavior', passed: true },
        { tool_id: 'tool-1', suite: 'recovery', passed: true },
      ],
    }));
    expect(v.certified).toBe(false);
    expect(check(v, 'contract_suite').status).toBe('fail');
    expect(check(v, 'contract_suite').detail).toMatch(/despite the suite summary/);
  });

  it('blocks when a suite passed on zero scenarios (nothing was exercised)', () => {
    const v = evaluateCertification(passingInput({
      results: [
        { tool_id: 'tool-1', suite: 'contract', passed: true },
        { tool_id: 'tool-1', suite: 'behavior', passed: true },
      ],
    }));
    expect(v.certified).toBe(false);
    expect(check(v, 'recovery_suite').status).toBe('fail');
    expect(check(v, 'recovery_suite').detail).toMatch(/no scenarios/);
  });

  it('blocks when the auth suite failed (missing or rejected credential)', () => {
    const v = evaluateCertification(passingInput({
      suites: {
        contract: { status: 'passed', passed: 2, failed: 0 },
        behavior: { status: 'passed', passed: 1, failed: 0 },
        recovery: { status: 'passed', passed: 1, failed: 0 },
        auth: { status: 'failed', passed: 0, failed: 1 },
        safety: { status: 'passed' },
      },
      results: [
        { tool_id: 'tool-1', suite: 'contract', passed: true },
        { tool_id: 'tool-1', suite: 'behavior', passed: true },
        { tool_id: 'tool-1', suite: 'recovery', passed: true },
        { tool_id: 'tool-1', suite: 'auth', passed: false },
      ],
      tools: [{ id: 'tool-1', credential_mode: 'api_key', effect_classes: ['read_only'] }],
    }));
    expect(v.certified).toBe(false);
    expect(check(v, 'auth_suite').status).toBe('fail');
  });

  it('blocks a mutating tool with no write-safety results, even when the stored safety summary claims a pass', () => {
    const v = evaluateCertification(passingInput({
      tools: [{ id: 'tool-1', credential_mode: 'none', effect_classes: ['mutating'] }],
    }));
    expect(v.certified).toBe(false);
    expect(check(v, 'safety_verified').status).toBe('fail');
    expect(check(v, 'safety_verified').detail).toMatch(/coverage gaps/);
  });

  it('certifies a mutating tool whose write-safety scenarios all passed (EV-06)', () => {
    const v = evaluateCertification(passingInput({
      suites: {
        contract: { status: 'passed', passed: 2, failed: 0 },
        behavior: { status: 'passed', passed: 1, failed: 0 },
        recovery: { status: 'passed', passed: 1, failed: 0 },
        auth: { status: 'not_tested', reason: 'All evaluated tools require no credentials (credential_mode = none).' },
        safety: { status: 'passed', passed: 2, failed: 0 },
      },
      results: [
        { tool_id: 'tool-1', suite: 'contract', passed: true },
        { tool_id: 'tool-1', suite: 'contract', passed: true },
        { tool_id: 'tool-1', suite: 'behavior', passed: true },
        { tool_id: 'tool-1', suite: 'recovery', passed: true },
        { tool_id: 'tool-1', suite: 'safety', scenario: 'write_invalid_payload_rejected', passed: true },
        { tool_id: 'tool-1', suite: 'safety', scenario: 'write_confirmation_contract', passed: true },
      ],
      tools: [{ id: 'tool-1', credential_mode: 'none', effect_classes: ['mutating'] }],
    }));
    expect(v.certified).toBe(true);
    expect(check(v, 'safety_verified').status).toBe('pass');
    expect(check(v, 'safety_verified').detail).toMatch(/write tool\(s\) passed/);
  });

  it('certifies an idempotent destructive tool with replay + confirmation scenarios (EV-06)', () => {
    const v = evaluateCertification(passingInput({
      suites: {
        contract: { status: 'passed', passed: 2, failed: 0 },
        behavior: { status: 'passed', passed: 1, failed: 0 },
        recovery: { status: 'passed', passed: 1, failed: 0 },
        auth: { status: 'not_tested', reason: 'All evaluated tools require no credentials (credential_mode = none).' },
        safety: { status: 'passed', passed: 3, failed: 0 },
      },
      results: [
        { tool_id: 'tool-1', suite: 'contract', passed: true },
        { tool_id: 'tool-1', suite: 'contract', passed: true },
        { tool_id: 'tool-1', suite: 'behavior', passed: true },
        { tool_id: 'tool-1', suite: 'recovery', passed: true },
        { tool_id: 'tool-1', suite: 'safety', scenario: 'write_invalid_payload_rejected', passed: true },
        { tool_id: 'tool-1', suite: 'safety', scenario: 'write_replay_idempotent', passed: true },
        { tool_id: 'tool-1', suite: 'safety', scenario: 'write_confirmation_contract', passed: true },
      ],
      tools: [{ id: 'tool-1', credential_mode: 'none', effect_classes: ['destructive'], idempotent: true }],
    }));
    expect(v.certified).toBe(true);
    expect(check(v, 'safety_verified').status).toBe('pass');
  });

  it('blocks when a write-safety scenario failed, and when an idempotent write skipped replay', () => {
    const failed = evaluateCertification(passingInput({
      suites: {
        contract: { status: 'passed', passed: 2, failed: 0 },
        behavior: { status: 'passed', passed: 1, failed: 0 },
        recovery: { status: 'passed', passed: 1, failed: 0 },
        auth: { status: 'not_tested', reason: 'All evaluated tools require no credentials (credential_mode = none).' },
        safety: { status: 'passed', passed: 1, failed: 1 },
      },
      results: [
        { tool_id: 'tool-1', suite: 'contract', passed: true },
        { tool_id: 'tool-1', suite: 'behavior', passed: true },
        { tool_id: 'tool-1', suite: 'recovery', passed: true },
        { tool_id: 'tool-1', suite: 'safety', scenario: 'write_invalid_payload_rejected', passed: false },
        { tool_id: 'tool-1', suite: 'safety', scenario: 'write_confirmation_contract', passed: true },
      ],
      tools: [{ id: 'tool-1', credential_mode: 'none', effect_classes: ['mutating'] }],
    }));
    expect(failed.certified).toBe(false);
    expect(check(failed, 'safety_verified').detail).toMatch(/scenario\(s\) failed/);

    const noReplay = evaluateCertification(passingInput({
      suites: {
        contract: { status: 'passed', passed: 2, failed: 0 },
        behavior: { status: 'passed', passed: 1, failed: 0 },
        recovery: { status: 'passed', passed: 1, failed: 0 },
        auth: { status: 'not_tested', reason: 'All evaluated tools require no credentials (credential_mode = none).' },
        safety: { status: 'passed', passed: 2, failed: 0 },
      },
      results: [
        { tool_id: 'tool-1', suite: 'contract', passed: true },
        { tool_id: 'tool-1', suite: 'behavior', passed: true },
        { tool_id: 'tool-1', suite: 'recovery', passed: true },
        { tool_id: 'tool-1', suite: 'safety', scenario: 'write_invalid_payload_rejected', passed: true },
        { tool_id: 'tool-1', suite: 'safety', scenario: 'write_confirmation_contract', passed: true },
      ],
      tools: [{ id: 'tool-1', credential_mode: 'none', effect_classes: ['destructive'], idempotent: true }],
    }));
    expect(noReplay.certified).toBe(false);
    expect(check(noReplay, 'safety_verified').detail).toMatch(/write_replay_idempotent/);
    expect(check(noReplay, 'tool_coverage').status).toBe('pass');
  });

  it('blocks a destructive tool and a tool with no effect classification when they have no safety results', () => {
    const destructive = evaluateCertification(passingInput({
      tools: [{ id: 'tool-1', credential_mode: 'none', effect_classes: ['destructive'] }],
    }));
    expect(check(destructive, 'safety_verified').status).toBe('fail');

    const unclassified = evaluateCertification(passingInput({
      tools: [{ id: 'tool-1', credential_mode: 'none', effect_classes: [] }],
    }));
    expect(check(unclassified, 'safety_verified').status).toBe('fail');
  });

  it('blocks when an evaluated tool skipped a required suite', () => {
    const v = evaluateCertification(passingInput({
      results: [
        { tool_id: 'tool-1', suite: 'contract', passed: true },
        { tool_id: 'tool-1', suite: 'behavior', passed: true },
        { tool_id: 'tool-1', suite: 'recovery', passed: true },
        { tool_id: 'tool-2', suite: 'contract', passed: true },
        { tool_id: 'tool-2', suite: 'behavior', passed: true },
      ],
      tools: [
        { id: 'tool-1', credential_mode: 'none', effect_classes: ['read_only'] },
        { id: 'tool-2', credential_mode: 'none', effect_classes: ['read_only'] },
      ],
    }));
    expect(v.certified).toBe(false);
    expect(check(v, 'tool_coverage').status).toBe('fail');
    expect(check(v, 'tool_coverage').detail).toMatch(/missing recovery/);
  });

  it('requires an auth result for credentialed tools in coverage', () => {
    const v = evaluateCertification(passingInput({
      suites: {
        contract: { status: 'passed', passed: 2, failed: 0 },
        behavior: { status: 'passed', passed: 1, failed: 0 },
        recovery: { status: 'passed', passed: 1, failed: 0 },
        auth: { status: 'passed', passed: 1, failed: 0 },
        safety: { status: 'passed' },
      },
      // The auth result belongs to a second tool; tool-1 has none.
      results: [
        { tool_id: 'tool-1', suite: 'contract', passed: true },
        { tool_id: 'tool-1', suite: 'behavior', passed: true },
        { tool_id: 'tool-1', suite: 'recovery', passed: true },
        { tool_id: 'tool-2', suite: 'contract', passed: true },
        { tool_id: 'tool-2', suite: 'behavior', passed: true },
        { tool_id: 'tool-2', suite: 'recovery', passed: true },
        { tool_id: 'tool-2', suite: 'auth', passed: true },
      ],
      tools: [
        { id: 'tool-1', credential_mode: 'api_key', effect_classes: ['read_only'] },
        { id: 'tool-2', credential_mode: 'api_key', effect_classes: ['read_only'] },
      ],
    }));
    expect(v.certified).toBe(false);
    expect(check(v, 'tool_coverage').detail).toMatch(/missing auth/);
  });

  it('blocks an empty run (no tools, no results)', () => {
    const v = evaluateCertification({
      runStatus: 'passed',
      suites: {
        contract: { status: 'failed', passed: 0, failed: 0 },
        behavior: { status: 'failed', passed: 0, failed: 0 },
        recovery: { status: 'failed', passed: 0, failed: 0 },
        auth: { status: 'not_tested' },
        safety: { status: 'passed' },
      },
      results: [],
      tools: [],
    });
    expect(v.certified).toBe(false);
    expect(check(v, 'tool_coverage').status).toBe('fail');
    expect(check(v, 'safety_verified').status).toBe('fail');
  });

  it('fails gracefully with no suite summaries at all (legacy run)', () => {
    const v = evaluateCertification(passingInput({ suites: undefined }));
    expect(v.certified).toBe(false);
    expect(check(v, 'contract_suite').detail).toMatch(/No contract suite summary/);
    expect(check(v, 'auth_suite').status).toBe('fail');
  });

  it('accepts effect_classes as a JSON string (stored-row shape)', () => {
    const v = evaluateCertification(passingInput({
      tools: [{ id: 'tool-1', credential_mode: 'none', effect_classes: '["read_only"]' }],
    }));
    expect(v.certified).toBe(true);
  });
});
