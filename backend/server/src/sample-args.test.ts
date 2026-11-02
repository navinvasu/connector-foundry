import { describe, it, expect } from 'vitest';
import { sampleValue, buildArgs } from './sample-args.js';

describe('sampleValue — arguments come from the spec, not from any one API', () => {
  it('prefers examples, then default, then the first enum member', () => {
    expect(sampleValue({ type: 'string', examples: ['ex'], default: 'd', enum: ['a'] })).toBe('ex');
    expect(sampleValue({ type: 'string', default: 'd', enum: ['a'] })).toBe('d');
    expect(sampleValue({ type: 'string', enum: ['metric', 'imperial'] })).toBe('metric');
  });

  it('fits declared formats and bounds', () => {
    expect(sampleValue({ type: 'string', format: 'date' })).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(sampleValue({ type: 'string', format: 'email' })).toBe('user@example.com');
    expect(sampleValue({ type: 'integer', minimum: 5 })).toBe(5);
    expect(sampleValue({ type: 'number', maximum: 0.5 })).toBe(0.5);
    expect(sampleValue({ type: 'string', minLength: 6 })).toHaveLength(6);
  });

  it('builds nested required object fields and arrays', () => {
    expect(sampleValue({
      type: 'object', required: ['id'], properties: { id: { type: 'integer' }, note: { type: 'string' } },
    })).toEqual({ id: 1 });
    expect(sampleValue({ type: 'array', items: { type: 'boolean' } })).toEqual([true]);
    expect(sampleValue({ type: 'array' })).toEqual(['test']);
  });
});

describe('buildArgs', () => {
  it('fills required args and optional args the spec gives an example for', () => {
    const args = buildArgs({
      input_schema: JSON.stringify({
        type: 'object',
        required: ['city'],
        properties: {
          city: { type: 'string' },
          units: { type: 'string', examples: ['metric'] },
          page: { type: 'integer', default: 1 },
        },
      }),
    });
    expect(args).toEqual({ city: 'test', units: 'metric' });
  });
});

describe('eval response shape checks work for any API', async () => {
  const { bodyKeys, hasPayload, isEmptyResults } = await import('./eval.js');
  it('accepts list answers as payload and reads keys from the first item', () => {
    expect(hasPayload([{ id: 1, name: 'a' }])).toBe(true);
    expect(bodyKeys([{ id: 1, name: 'a' }])).toEqual(['id', 'name']);
    expect(hasPayload([])).toBe(false);
    expect(hasPayload({})).toBe(false);
  });
  it('treats empty lists or all-empty list fields as an empty result', () => {
    expect(isEmptyResults([])).toBe(true);
    expect(isEmptyResults({ data: [], total: 0 })).toBe(true);
    expect(isEmptyResults({ data: [{ id: 1 }] })).toBe(false);
    expect(isEmptyResults({ error: 'not found' })).toBe(false);
  });
});
