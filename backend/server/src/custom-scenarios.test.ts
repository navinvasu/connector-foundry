import { describe, it, expect } from 'vitest';
import {
  parseCustomScenarioRow, customScenariosOf, evaluateCustomExpectation,
} from './custom-scenarios.js';

describe('parseCustomScenarioRow', () => {
  it('parses a stored row (JSONB objects and string-era JSON alike)', () => {
    const fromObjects = parseCustomScenarioRow({
      id: 'scen-1', project_id: 'p1', tool_id: 'tool-1', name: ' Required args happy path ',
      given_args: { latitude: 52.52 }, expect_status: 200,
      expect_body_keys: [' current ', 'temperature'], enabled: true,
    });
    expect(fromObjects).toMatchObject({
      id: 'scen-1', name: 'Required args happy path', expect_status: 200,
      expect_body_keys: ['current', 'temperature'], enabled: true,
    });
    const fromStrings = parseCustomScenarioRow({
      id: 'scen-2', project_id: 'p1', tool_id: 'tool-1', name: 'No status pin',
      given_args: '{"latitude":52.52}', expect_status: null,
      expect_body_keys: '[]', enabled: true,
    });
    expect(fromStrings?.given_args).toEqual({ latitude: 52.52 });
    expect(fromStrings?.expect_status).toBeNull();
  });

  it('returns null for malformed rows instead of throwing', () => {
    expect(parseCustomScenarioRow(null)).toBeNull();
    expect(parseCustomScenarioRow({ id: 'x', tool_id: 't', name: '  ' })).toBeNull();
    expect(parseCustomScenarioRow({ tool_id: 't', name: 'ok' })).toBeNull();
  });

  it('sanitizes out-of-range status and non-object args', () => {
    const s = parseCustomScenarioRow({
      id: 'scen-3', project_id: 'p1', tool_id: 'tool-1', name: 'Odd',
      given_args: ['not', 'an', 'object'], expect_status: 99,
      expect_body_keys: 'not-json', enabled: false,
    });
    expect(s?.given_args).toEqual({});
    expect(s?.expect_status).toBeNull();
    expect(s?.expect_body_keys).toEqual([]);
    expect(s?.enabled).toBe(false);
  });
});

describe('customScenariosOf', () => {
  it('returns only enabled, well-formed scenarios from a json_agg payload', () => {
    const scenarios = customScenariosOf({
      custom_scenarios: [
        { id: 'a', tool_id: 'tool-1', name: 'Live', given_args: {}, expect_status: null, expect_body_keys: [], enabled: true },
        { id: 'b', tool_id: 'tool-1', name: 'Off', given_args: {}, expect_status: null, expect_body_keys: [], enabled: false },
        { id: 'c', tool_id: 'tool-1', name: '', given_args: {}, expect_status: null, expect_body_keys: [], enabled: true },
      ],
    });
    expect(scenarios.map((s) => s.id)).toEqual(['a']);
    expect(customScenariosOf({})).toEqual([]);
    expect(customScenariosOf({ custom_scenarios: '[{"id":"d","tool_id":"t","name":"S","enabled":true}]' }))
      .toHaveLength(1);
  });
});

describe('evaluateCustomExpectation', () => {
  it('passes an exact status + all expected keys', () => {
    const v = evaluateCustomExpectation(
      { expect_status: 200, expect_body_keys: ['current', 'hourly'] },
      { status: 200, body: { current: {}, hourly: {} } });
    expect(v.passed).toBe(true);
    expect(v.bodyKeys).toEqual(['current', 'hourly']);
  });

  it('fails a wrong status, a missing key, and a non-object body', () => {
    expect(evaluateCustomExpectation(
      { expect_status: 201, expect_body_keys: [] },
      { status: 200, body: {} }).failures[0]).toContain('Expected HTTP 201, got 200');
    expect(evaluateCustomExpectation(
      { expect_status: 200, expect_body_keys: ['missing'] },
      { status: 200, body: { other: 1 } }).passed).toBe(false);
    const nonObject = evaluateCustomExpectation(
      { expect_status: 200, expect_body_keys: ['x'] },
      { status: 200, body: 'text' });
    expect(nonObject.passed).toBe(false);
    expect(nonObject.failures[0]).toContain('not an object');
  });

  it('expects 2xx when no status is pinned (never a vacuous pass)', () => {
    expect(evaluateCustomExpectation(
      { expect_status: null, expect_body_keys: [] },
      { status: 404, body: {} }).passed).toBe(false);
    expect(evaluateCustomExpectation(
      { expect_status: null, expect_body_keys: ['id'] },
      { status: 200, body: { id: 1 } }).passed).toBe(true);
    // An error case pins its 4xx explicitly.
    expect(evaluateCustomExpectation(
      { expect_status: 422, expect_body_keys: ['error'] },
      { status: 422, body: { error: 'bad input' } }).passed).toBe(true);
  });
});
