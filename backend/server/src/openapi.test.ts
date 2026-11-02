import { describe, it, expect } from 'vitest';
import {
  parseOpenApi,
  classifyEffect,
  docScore,
  buildInventory,
  type ParsedOperation,
} from './openapi.js';

const spec = {
  openapi: '3.0.3',
  info: { title: 'Acme Billing', version: '1.2.0' },
  servers: [{ url: 'https://api.acme.test/v1' }],
  paths: {
    '/invoices': {
      get: {
        operationId: 'list_invoices',
        summary: 'List invoices',
        parameters: [
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 20 }, description: 'Page size' },
        ],
        responses: { '200': { description: 'ok' }, '400': { description: 'bad request' } },
      },
      post: {
        summary: 'Create invoice',
        requestBody: { content: { 'application/json': { schema: { type: 'object' } } } },
        responses: { '201': { description: 'created' } },
      },
    },
    '/invoices/{id}': {
      parameters: [{ name: 'id', in: 'path', schema: { type: 'string' } }],
      delete: {
        operationId: 'delete-invoice!',
        responses: { '204': { description: 'gone' } },
      },
    },
  },
};

describe('parseOpenApi', () => {
  it('parses title, version, base URL, and operations', () => {
    const p = parseOpenApi(spec);
    expect(p.title).toBe('Acme Billing');
    expect(p.version).toBe('1.2.0');
    expect(p.baseUrl).toBe('https://api.acme.test/v1');
    expect(p.operations).toHaveLength(3);
    expect(p.specHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('merges path-level parameters into each operation', () => {
    const p = parseOpenApi(spec);
    const del = p.operations.find((o) => o.method === 'DELETE')!;
    expect(del.parameters.map((x) => x.name)).toContain('id');
    expect(del.parameters.find((x) => x.name === 'id')!.required).toBe(true);
  });

  it('dedupes parameters by name+location', () => {
    const dup = structuredClone(spec) as any;
    dup.paths['/invoices'].get.parameters.push({ name: 'limit', in: 'query', schema: { type: 'integer' } });
    const p = parseOpenApi(dup);
    const get = p.operations.find((o) => o.method === 'GET')!;
    expect(get.parameters.filter((x) => x.name === 'limit')).toHaveLength(1);
  });

  it('derives base URL from host+basePath for Swagger 2.0', () => {
    const p = parseOpenApi({ swagger: '2.0', host: 'api.acme.test', basePath: '/v2', schemes: ['https'], info: {}, paths: {} });
    expect(p.baseUrl).toBe('https://api.acme.test/v2');
  });

  it('rejects non-object specs and unsupported versions', () => {
    expect(() => parseOpenApi(null)).toThrow('Spec must be a JSON object');
    expect(() => parseOpenApi({ openapi: '4.0.0', info: {}, paths: {} })).toThrow('Unsupported spec version');
    expect(() => parseOpenApi({ info: {}, paths: {} })).toThrow('Unsupported spec version');
  });

  it('flags operations without documented error responses', () => {
    const p = parseOpenApi(spec);
    const post = p.operations.find((o) => o.method === 'POST')!;
    const get = p.operations.find((o) => o.method === 'GET')!;
    expect(post.hasErrorResponses).toBe(false);
    expect(get.hasErrorResponses).toBe(true);
  });

  it('captures security scheme types and per-operation requirements (AB-05)', () => {
    const p = parseOpenApi({
      openapi: '3.0.3',
      info: { title: 'Secured', version: '1' },
      servers: [{ url: 'https://api.test' }],
      components: {
        securitySchemes: {
          ApiKeyAuth: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
          OAuth: { type: 'oauth2', flows: { authorizationCode: { scopes: { read: 'r', write: 'w' } } } },
        },
      },
      paths: {
        '/keys': { get: { security: [{ ApiKeyAuth: [] }], responses: { '200': { description: 'ok' } } } },
        '/me': { get: { security: [{ OAuth: ['read', 'write'] }], responses: { '200': { description: 'ok' } } } },
        '/open': { get: { responses: { '200': { description: 'ok' } } } },
      },
    });
    expect(p.securitySchemeTypes).toEqual({ ApiKeyAuth: 'apiKey', OAuth: 'oauth2' });
    const byPath = Object.fromEntries(p.operations.map((o) => [o.path, o]));
    expect(byPath['/keys'].authSchemes).toEqual(['ApiKeyAuth']);
    expect(byPath['/me'].authSchemes).toEqual(['OAuth']);
    expect(byPath['/me'].authScopes).toEqual(['read', 'write']);
    expect(byPath['/open'].authSchemes).toEqual([]);
  });

  it('captures security scheme details for broker injection (AB-02)', () => {
    const p = parseOpenApi({
      openapi: '3.0.3',
      info: { title: 'Secured', version: '1' },
      servers: [{ url: 'https://api.test' }],
      components: {
        securitySchemes: {
          ApiKeyAuth: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
          QueryKey: { type: 'apiKey', in: 'query', name: 'api_key' },
          BearerAuth: { type: 'http', scheme: 'bearer' },
        },
      },
      paths: { '/a': { get: { responses: { '200': { description: 'ok' } } } } },
    });
    expect(p.securitySchemeDetails).toEqual({
      ApiKeyAuth: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
      QueryKey: { type: 'apiKey', in: 'query', name: 'api_key' },
      BearerAuth: { type: 'http', scheme: 'bearer' },
    });
  });

  it('captures Swagger 2.0 securityDefinitions details (AB-02)', () => {
    const p = parseOpenApi({
      swagger: '2.0',
      info: { title: 'Legacy', version: '1' },
      host: 'api.test',
      basePath: '/v1',
      securityDefinitions: {
        Basic: { type: 'basic' },
        Key: { type: 'apiKey', in: 'query', name: 'key' },
      },
      paths: { '/a': { get: { responses: { '200': { description: 'ok' } } } } },
    });
    // IA-01: Swagger 2.0 securityDefinitions are normalized to the 3.x shape
    // (basic → http/basic) before capture, so the compiler sees one dialect.
    expect(p.securitySchemeDetails).toEqual({
      Basic: { type: 'http', scheme: 'basic' },
      Key: { type: 'apiKey', in: 'query', name: 'key' },
    });
  });

  it('applies global security to operations without their own, and lets security: [] opt out (AB-05)', () => {
    const p = parseOpenApi({
      openapi: '3.0.3',
      info: { title: 'GlobalAuth', version: '1' },
      servers: [{ url: 'https://api.test' }],
      security: [{ BearerAuth: [] }],
      components: { securitySchemes: { BearerAuth: { type: 'http', scheme: 'bearer' } } },
      paths: {
        '/a': { get: { responses: { '200': { description: 'ok' } } } },
        '/b': { get: { security: [], responses: { '200': { description: 'ok' } } } },
      },
    });
    const byPath = Object.fromEntries(p.operations.map((o) => [o.path, o]));
    expect(byPath['/a'].authSchemes).toEqual(['BearerAuth']);
    expect(byPath['/b'].authSchemes).toEqual([]);
    expect(p.securitySchemeTypes).toEqual({ BearerAuth: 'http' });
  });

  it('reads Swagger 2.0 securityDefinitions types (AB-05)', () => {
    const p = parseOpenApi({
      swagger: '2.0', host: 'api.test', info: { title: 't', version: '1' },
      securityDefinitions: { legacy_oauth: { type: 'oauth2', flow: 'accessCode', scopes: { read: 'r' } } },
      paths: { '/x': { get: { security: [{ legacy_oauth: ['read'] }], responses: { '200': { description: 'ok' } } } } },
    });
    expect(p.securitySchemeTypes).toEqual({ legacy_oauth: 'oauth2' });
    expect(p.operations[0].authSchemes).toEqual(['legacy_oauth']);
    expect(p.operations[0].authScopes).toEqual(['read']);
  });
});

describe('classifyEffect', () => {
  it.each([
    ['GET', '/invoices', 'READ'],
    ['HEAD', '/x', 'READ'],
    ['POST', '/invoices', 'WRITE'],
    ['PUT', '/invoices/1', 'WRITE'],
    ['PATCH', '/invoices/1', 'WRITE'],
    ['DELETE', '/invoices/1', 'DESTRUCTIVE'],
  ])('%s %s -> %s', (method, path, expected) => {
    expect(classifyEffect(method, path)).toBe(expected);
  });
});

describe('docScore', () => {
  const base: ParsedOperation = {
    method: 'GET', path: '/x', operationId: undefined, summary: '', description: '',
    parameters: [], requestBodySchema: undefined, responseCodes: ['200'],
    hasErrorResponses: false, deprecated: false, authSchemes: [], authScopes: [], tags: [],
  };
  it('rewards summary, description, operationId, param docs, and error responses', () => {
    expect(docScore(base)).toBe(25); // no params at all still earns the param-docs points
    expect(docScore({ ...base, summary: 's', description: 'd', operationId: 'op', hasErrorResponses: true }))
      .toBe(100);
  });
  it('caps at 100', () => {
    expect(docScore({ ...base, summary: 's', description: 'd', operationId: 'op', hasErrorResponses: true })).toBeLessThanOrEqual(100);
  });
});

describe('buildInventory', () => {
  it('flags missing host, missing auth schemes, and mutating operations', () => {
    const p = parseOpenApi({ openapi: '3.0.0', info: { title: 't', version: '1' }, paths: {
      '/invoices': { post: { responses: { '201': { description: 'ok' } } } },
    } });
    const { findings } = buildInventory(p);
    const codes = findings.map((f) => f.code);
    expect(codes).toContain('HOST');
    expect(codes).toContain('AUTH');
    expect(codes).toContain('EFFECT');
    expect(findings.find((f) => f.code === 'EFFECT')!.severity).toBe('warning');
  });

  it('marks destructive operations as blockers', () => {
    const p = parseOpenApi({ openapi: '3.0.0', info: { title: 't', version: '1' },
      servers: [{ url: 'https://x.test' }], paths: { '/invoices/1': { delete: { responses: {} } } } });
    const { findings } = buildInventory(p);
    const effect = findings.find((f) => f.code === 'EFFECT')!;
    expect(effect.severity).toBe('blocker');
  });
});

describe('resolveServerUrl (published specs with relative servers / variables)', async () => {
  const { resolveServerUrl, parseOpenApi } = await import('./openapi.js');
  it('resolves a relative server URL against the document URL', () => {
    expect(resolveServerUrl({ url: '/api/v3' }, 'https://petstore3.swagger.io/api/v3/openapi.json')).toBe('https://petstore3.swagger.io/api/v3');
    expect(resolveServerUrl({ url: 'v2/' }, 'https://x.test/specs/openapi.json')).toBe('https://x.test/specs/v2');
  });
  it('fills server variables from their defaults', () => {
    expect(resolveServerUrl({ url: 'https://{region}.api.test/{v}', variables: { region: { default: 'eu' }, v: { default: 'v1' } } }))
      .toBe('https://eu.api.test/v1');
  });
  it('leaves absolute URLs alone and relative ones as written without a document URL', () => {
    expect(resolveServerUrl({ url: 'https://api.test/' }, 'https://other.test/spec')).toBe('https://api.test');
    expect(resolveServerUrl({ url: '/api' })).toBe('/api');
  });
  it('parseOpenApi applies it to baseUrl', () => {
    const spec = { openapi: '3.0.0', info: { title: 't', version: '1' }, servers: [{ url: '/api/v3' }], paths: {} };
    expect(parseOpenApi(spec, 'https://petstore3.swagger.io/api/v3/openapi.json').baseUrl).toBe('https://petstore3.swagger.io/api/v3');
  });
});
