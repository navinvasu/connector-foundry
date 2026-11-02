// IA-04: spec validation. A broken spec must fail at import with exactly
// what's wrong and where — before IA-04 a dangling $ref silently degraded
// to a generic object schema and the connector broke much later.
import { describe, it, expect } from 'vitest';
import { validateSpec, withLineNumbers, suggestPointer, SpecValidationError } from './spec-validate.js';

const goodSpec = {
  openapi: '3.0.3',
  info: { title: 'Pet Store', version: '1.0.0' },
  servers: [{ url: 'https://pets.test/v1' }],
  paths: {
    '/pets': {
      get: {
        operationId: 'listPets',
        parameters: [{ $ref: '#/components/parameters/Limit' }],
        responses: {
          '200': {
            description: 'ok',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } },
          },
        },
      },
      post: {
        operationId: 'createPet',
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  pet: { $ref: '#/components/schemas/Pet' },
                  tags: { type: 'array', items: { $ref: '#/components/schemas/Tag' } },
                },
              },
            },
          },
        },
        responses: { '201': { $ref: '#/components/responses/Created' } },
      },
    },
  },
  components: {
    parameters: { Limit: { name: 'limit', in: 'query', schema: { type: 'integer' } } },
    responses: { Created: { description: 'created' } },
    schemas: {
      Pet: { type: 'object', properties: { name: { type: 'string' } } },
      Tag: { type: 'string' },
    },
  },
};

describe('validateSpec — sound specs', () => {
  it('accepts a spec whose refs all resolve (params, bodies, responses, nested)', () => {
    expect(validateSpec(goodSpec)).toEqual([]);
  });

  it('accepts the document root ref and escaped pointer segments', () => {
    const spec = {
      'a/b': { 'c~d': { type: 'string' } },
      x: { $ref: '#/a~1b/c~0d' },
      y: { $ref: '#' },
    };
    expect(validateSpec(spec)).toEqual([]);
  });

  it('resolves array indices in pointers', () => {
    const spec = { list: [{ name: 'a' }, { name: 'b' }], x: { $ref: '#/list/1' } };
    expect(validateSpec(spec)).toEqual([]);
  });

  it('non-object input has no issues (parseOpenApi owns that error)', () => {
    expect(validateSpec('nope')).toEqual([]);
    expect(validateSpec(null)).toEqual([]);
    expect(validateSpec(42)).toEqual([]);
  });
});

describe('validateSpec — broken refs (the AC)', () => {
  it('names the exact pointer and ref for a dangling schema ref', () => {
    const spec = structuredClone(goodSpec) as any;
    spec.paths['/pets'].get.responses['200'].content['application/json'].schema.$ref =
      '#/components/schemas/Pets';
    const issues = validateSpec(spec);
    expect(issues).toHaveLength(1);
    expect(issues[0].pointer).toBe(
      '/paths/~1pets/get/responses/200/content/application~1json/schema/$ref',
    );
    expect(issues[0].ref).toBe('#/components/schemas/Pets');
    expect(issues[0].message).toMatch(/does not resolve/);
    // The repair suggestion: the schema that actually exists.
    expect(issues[0].suggestion).toBe('#/components/schemas/Pet');
  });

  it('reports every broken ref in document order, not just the first', () => {
    const spec = {
      a: { $ref: '#/components/schemas/Missing1' },
      b: { deep: { $ref: '#/components/schemas/Missing2' } },
      components: { schemas: { Present: { type: 'object' } } },
    };
    const issues = validateSpec(spec);
    expect(issues.map((i) => i.ref)).toEqual([
      '#/components/schemas/Missing1',
      '#/components/schemas/Missing2',
    ]);
    expect(issues.map((i) => i.pointer)).toEqual(['/a/$ref', '/b/deep/$ref']);
  });

  it('suggests the closest existing pointer for a typo', () => {
    const spec = {
      components: { schemas: { Invoice: { type: 'object' }, Customer: { type: 'object' } } },
      x: { $ref: '#/components/schemas/Invoce' },
    };
    const [issue] = validateSpec(spec);
    expect(issue.suggestion).toBe('#/components/schemas/Invoice');
  });

  it('offers no suggestion when nothing is close', () => {
    const spec = {
      components: { schemas: { Alpha: { type: 'object' } } },
      x: { $ref: '#/totally/different/zzzzzzzz' },
    };
    const [issue] = validateSpec(spec);
    expect(issue.suggestion).toBeUndefined();
  });

  it('flags external refs with the inline-it repair', () => {
    const spec = {
      x: { $ref: 'https://example.com/common.yaml#/components/schemas/Pet' },
      y: { $ref: './shared.json#/components/schemas/Tag' },
    };
    const issues = validateSpec(spec);
    expect(issues).toHaveLength(2);
    for (const issue of issues) {
      expect(issue.message).toMatch(/external \$ref/);
      expect(issue.message).toMatch(/inline the target/);
    }
  });

  it('flags a fragment that is not a JSON Pointer', () => {
    const [issue] = validateSpec({ x: { $ref: '#Pet' } });
    expect(issue.message).toMatch(/not a JSON Pointer/);
  });

  it('flags non-string and empty $ref values', () => {
    const issues = validateSpec({ x: { $ref: 42 }, y: { $ref: '  ' } });
    expect(issues).toHaveLength(2);
    expect(issues[0].message).toMatch(/non-empty string/);
    expect(issues[1].message).toMatch(/non-empty string/);
  });

  it('flags an out-of-range array index', () => {
    const [issue] = validateSpec({ list: [{ name: 'a' }], x: { $ref: '#/list/5' } });
    expect(issue.message).toMatch(/does not resolve/);
  });
});

describe('suggestPointer', () => {
  it('handles an empty document', () => {
    expect(suggestPointer({}, '#/components/schemas/Pet')).toBeUndefined();
  });
});

describe('withLineNumbers', () => {
  const text = [
    '{',
    '  "components": { "schemas": { "Pet": { "type": "object" } } },',
    '  "a": { "$ref": "#/components/schemas/Pets" },',
    '  "b": { "$ref": "#/components/schemas/Pets" }',
    '}',
  ].join('\n');

  it('attaches the 1-based line of each ref, successive lines for repeats', () => {
    const issues = withLineNumbers(validateSpec(JSON.parse(text)), text);
    expect(issues.map((i) => i.line)).toEqual([3, 4]);
  });

  it('leaves line unset when the ref cannot be found in the text', () => {
    const issues = withLineNumbers(
      [{ pointer: '/a/$ref', ref: '#/nope', message: 'x' }],
      text,
    );
    expect(issues[0].line).toBeUndefined();
  });

  it('returns issues unchanged for empty text', () => {
    const input = [{ pointer: '/a/$ref', ref: '#/x', message: 'x' }];
    expect(withLineNumbers(input, '')).toEqual(input);
  });
});

describe('SpecValidationError', () => {
  it('summarizes the problems in its message', () => {
    const err = new SpecValidationError([
      { pointer: '/a/$ref', ref: '#/x', message: '/a/$ref: broken' },
    ]);
    expect(err.message).toMatch(/1 problem/);
    expect(err.issues).toHaveLength(1);
  });
});
