import { describe, expect, it } from 'vitest';
import { convertSwaggerToOpenApi, parseOpenApi, type ParsedSpec } from './openapi.js';

// IA-01: a Swagger 2.0 document and its hand-written OpenAPI 3.x equivalent
// must produce the same parsed operations, so the rest of the pipeline
// (compiler → eval → broker) never sees two dialects.
const SWAGGER_2 = {
  swagger: '2.0',
  info: { title: 'Acme Billing', version: '1.2.0' },
  host: 'api.acme.test',
  basePath: '/v1',
  schemes: ['https'],
  securityDefinitions: {
    ApiKeyAuth: { type: 'apiKey', name: 'X-API-Key', in: 'header' },
  },
  security: [{ ApiKeyAuth: [] }],
  definitions: {
    Invoice: {
      type: 'object',
      properties: { id: { type: 'string' }, amount: { type: 'number' } },
    },
  },
  paths: {
    '/invoices': {
      get: {
        operationId: 'listInvoices',
        summary: 'List invoices',
        parameters: [
          { name: 'limit', in: 'query', type: 'integer', required: false, description: 'Max results' },
        ],
        responses: { '200': { description: 'ok' }, '400': { description: 'bad' } },
      },
      post: {
        operationId: 'createInvoice',
        summary: 'Create invoice',
        parameters: [
          { name: 'invoice', in: 'body', required: true, schema: { $ref: '#/definitions/Invoice' } },
        ],
        responses: { '201': { description: 'created' } },
      },
    },
    '/invoices/{id}': {
      get: {
        operationId: 'getInvoice',
        summary: 'Get invoice',
        parameters: [{ name: 'id', in: 'path', required: true, type: 'string' }],
        responses: { '200': { description: 'ok' }, '404': { description: 'missing' } },
      },
    },
  },
};

const OPENAPI_3 = {
  openapi: '3.0.3',
  info: { title: 'Acme Billing', version: '1.2.0' },
  servers: [{ url: 'https://api.acme.test/v1' }],
  components: {
    securitySchemes: {
      ApiKeyAuth: { type: 'apiKey', name: 'X-API-Key', in: 'header' },
    },
    schemas: {
      Invoice: {
        type: 'object',
        properties: { id: { type: 'string' }, amount: { type: 'number' } },
      },
    },
  },
  security: [{ ApiKeyAuth: [] }],
  paths: {
    '/invoices': {
      get: {
        operationId: 'listInvoices',
        summary: 'List invoices',
        parameters: [
          { name: 'limit', in: 'query', required: false, description: 'Max results', schema: { type: 'integer' } },
        ],
        responses: { '200': { description: 'ok' }, '400': { description: 'bad' } },
      },
      post: {
        operationId: 'createInvoice',
        summary: 'Create invoice',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Invoice' } } },
        },
        responses: { '201': { description: 'created' } },
      },
    },
    '/invoices/{id}': {
      get: {
        operationId: 'getInvoice',
        summary: 'Get invoice',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'ok' }, '404': { description: 'missing' } },
      },
    },
  },
};

function project(p: ParsedSpec) {
  return {
    baseUrl: p.baseUrl,
    securitySchemes: p.securitySchemes,
    securitySchemeTypes: p.securitySchemeTypes,
    securitySchemeDetails: p.securitySchemeDetails,
    schemaCount: p.schemaCount,
    operations: p.operations.map((o) => ({
      method: o.method,
      path: o.path,
      parameters: o.parameters,
      requestBodySchema: o.requestBodySchema,
      responseCodes: o.responseCodes,
      hasErrorResponses: o.hasErrorResponses,
      authSchemes: o.authSchemes,
      authScopes: o.authScopes,
    })),
  };
}

describe('IA-01 Swagger 2.0 parity', () => {
  it('produces the same parsed spec as the OpenAPI 3.x equivalent', () => {
    const fromSwagger = parseOpenApi(JSON.parse(JSON.stringify(SWAGGER_2)));
    const fromOpenApi = parseOpenApi(JSON.parse(JSON.stringify(OPENAPI_3)));
    expect(project(fromSwagger)).toEqual(project(fromOpenApi));
  });

  it('surfaces the converted body schema (ref rewritten to components)', () => {
    const p = parseOpenApi(JSON.parse(JSON.stringify(SWAGGER_2)));
    const create = p.operations.find((o) => o.operationId === 'createInvoice')!;
    expect(create.requestBodySchema).toEqual({ $ref: '#/components/schemas/Invoice' });
  });
});

describe('convertSwaggerToOpenApi', () => {
  it('builds servers from host/basePath/schemes', () => {
    const out = convertSwaggerToOpenApi({ swagger: '2.0', host: 'h.test', basePath: '/b', schemes: ['https', 'http'], paths: {} });
    expect(out.servers).toEqual([{ url: 'https://h.test/b' }, { url: 'http://h.test/b' }]);
  });

  it('rewrites $refs for definitions, parameters, and responses', () => {
    const out = convertSwaggerToOpenApi({
      swagger: '2.0',
      paths: {
        '/a': {
          get: {
            parameters: [{ $ref: '#/parameters/P' }],
            responses: { '200': { description: 'ok', schema: { $ref: '#/definitions/Thing' } }, default: { $ref: '#/responses/Err' } },
          },
        },
      },
    });
    expect(out.paths['/a'].get.parameters[0].$ref).toBe('#/components/parameters/P');
    expect(out.paths['/a'].get.responses['200'].schema.$ref).toBe('#/components/schemas/Thing');
    expect(out.paths['/a'].get.responses.default.$ref).toBe('#/components/responses/Err');
  });

  it('converts formData parameters into a urlencoded requestBody', () => {
    const out = convertSwaggerToOpenApi({
      swagger: '2.0',
      paths: {
        '/login': {
          post: {
            parameters: [
              { name: 'user', in: 'formData', type: 'string', required: true },
              { name: 'pass', in: 'formData', type: 'string' },
            ],
            responses: { '200': { description: 'ok' } },
          },
        },
      },
    });
    const post = out.paths['/login'].post;
    expect(post.parameters).toEqual([]);
    expect(post.requestBody.content['application/x-www-form-urlencoded'].schema).toEqual({
      type: 'object',
      properties: { user: { type: 'string' }, pass: { type: 'string' } },
      required: ['user'],
    });
  });

  it('maps oauth2 flow names to the 3.x flows object', () => {
    const out = convertSwaggerToOpenApi({
      swagger: '2.0',
      securityDefinitions: {
        O: { type: 'oauth2', flow: 'accessCode', authorizationUrl: 'https://a/authorize', tokenUrl: 'https://a/token', scopes: { read: 'r' } },
      },
      paths: {},
    });
    expect(out.components.securitySchemes.O).toEqual({
      type: 'oauth2',
      flows: { authorizationCode: { authorizationUrl: 'https://a/authorize', tokenUrl: 'https://a/token', scopes: { read: 'r' } } },
    });
  });

  it('never mutates the source document', () => {
    const src = JSON.parse(JSON.stringify(SWAGGER_2));
    const before = JSON.stringify(src);
    convertSwaggerToOpenApi(src);
    expect(JSON.stringify(src)).toBe(before);
  });

  it('returns non-Swagger input untouched', () => {
    const doc = { openapi: '3.0.3', paths: {} };
    expect(convertSwaggerToOpenApi(doc)).toBe(doc);
  });
});
