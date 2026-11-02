import { describe, expect, it } from 'vitest';
import {
  convertPostmanToOpenApi, isPostmanCollection, parseOpenApi, type ParsedSpec,
} from './openapi.js';
import { compileOperation } from './compiler.js';

// IA-02: a realistic Postman Collection v2.1 (folders, collection variables,
// inherited + per-request auth helpers, disabled entries, JSON + form
// bodies, saved responses) must import with the same operations/params the
// hand-written OpenAPI equivalent would produce.
const COLLECTION = {
  info: {
    name: 'Acme Billing',
    description: 'Billing API exported from Postman',
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    version: '1.2.0',
  },
  variable: [
    { key: 'baseUrl', value: 'https://api.acme.test/v1' },
  ],
  auth: {
    type: 'apikey',
    apikey: [
      { key: 'in', value: 'header', type: 'string' },
      { key: 'key', value: 'X-API-Key', type: 'string' },
      { key: 'value', value: '{{apiKey}}', type: 'string' },
    ],
  },
  item: [
    {
      name: 'Billing',
      item: [
        {
          name: 'List invoices',
          request: {
            method: 'GET',
            description: 'List the invoices for the account',
            header: [
              { key: 'X-Request-Source', value: 'console', description: 'Originating client' },
              { key: 'X-Skip-Me', value: 'nope', disabled: true },
              { key: 'Accept', value: 'application/json' },
            ],
            url: {
              protocol: 'https',
              host: ['api', 'acme', 'test'],
              path: ['v1', 'invoices'],
              query: [
                { key: 'limit', value: '10', description: 'Max results' },
                { key: 'status', value: 'paid' },
                { key: 'debug', value: '1', disabled: true },
              ],
            },
          },
          response: [],
        },
        {
          name: 'Get invoice',
          request: {
            method: 'GET',
            url: {
              protocol: 'https',
              host: ['api', 'acme', 'test'],
              path: ['v1', 'invoices', ':id'],
              variable: [{ key: 'id', value: '', description: 'Invoice id' }],
            },
          },
          response: [
            { name: 'Found', code: 200, status: 'OK' },
            { name: 'Missing', code: 404, status: 'Not Found' },
          ],
        },
        {
          name: 'Create invoice',
          request: {
            method: 'POST',
            auth: {
              type: 'bearer',
              bearer: [{ key: 'token', value: '{{token}}', type: 'string' }],
            },
            header: [
              { key: 'Content-Type', value: 'application/json' },
              { key: 'Authorization', value: 'Bearer {{token}}' },
            ],
            url: { raw: '{{baseUrl}}/invoices' },
            body: {
              mode: 'raw',
              raw: '{"customer": "cus_1", "amount": 42, "paid": true}',
              options: { raw: { language: 'json' } },
            },
          },
          response: [{ name: 'Created', code: 201, status: 'Created' }],
        },
      ],
    },
    {
      name: 'Admin',
      item: [
        {
          name: 'Delete invoice',
          request: {
            method: 'DELETE',
            auth: { type: 'noauth' },
            url: { raw: '{{baseUrl}}/invoices/{{invoiceId}}' },
          },
        },
        {
          name: 'Login',
          request: {
            method: 'POST',
            url: { raw: '{{baseUrl}}/login' },
            body: {
              mode: 'urlencoded',
              urlencoded: [
                { key: 'user', value: 'a@b.c', type: 'text' },
                { key: 'pass', value: 'secret', type: 'text' },
                { key: 'skip', value: 'x', disabled: true },
              ],
            },
          },
        },
      ],
    },
  ],
};

function op(p: ParsedSpec, operationId: string) {
  const found = p.operations.find((o) => o.operationId === operationId);
  expect(found, `operation ${operationId}`).toBeTruthy();
  return found!;
}

describe('IA-02 Postman Collection import — the AC', () => {
  const parsed = parseOpenApi(JSON.parse(JSON.stringify(COLLECTION)));

  it('imports with correct methods, paths, and title', () => {
    expect(parsed.title).toBe('Acme Billing');
    expect(parsed.baseUrl).toBe('https://api.acme.test');
    const keys = parsed.operations.map((o) => `${o.method} ${o.path}`).sort();
    expect(keys).toEqual([
      'DELETE /v1/invoices/{invoiceId}',
      'GET /v1/invoices',
      'GET /v1/invoices/{id}',
      'POST /v1/invoices',
      'POST /v1/login',
    ]);
  });

  it('maps query, header, and path params (disabled entries skipped)', () => {
    const list = op(parsed, 'listInvoices');
    expect(list.parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'limit', location: 'query', type: 'integer', example: '10', description: 'Max results' }),
      expect.objectContaining({ name: 'status', location: 'query', type: 'string' }),
      expect.objectContaining({ name: 'X-Request-Source', location: 'header', example: 'console' }),
    ]));
    expect(list.parameters.map((p) => p.name)).not.toContain('debug');
    expect(list.parameters.map((p) => p.name)).not.toContain('X-Skip-Me');
    expect(list.parameters.map((p) => p.name)).not.toContain('Accept');

    const get = op(parsed, 'getInvoice');
    expect(get.parameters).toEqual([
      expect.objectContaining({ name: 'id', location: 'path', required: true, description: 'Invoice id' }),
    ]);
    expect(get.responseCodes.sort()).toEqual(['200', '404']);
    expect(get.hasErrorResponses).toBe(true);
  });

  it('derives the JSON body schema from the saved example', () => {
    const create = op(parsed, 'createInvoice');
    expect(create.requestBodySchema).toEqual({
      type: 'object',
      properties: {
        customer: { type: 'string' },
        amount: { type: 'integer' },
        paid: { type: 'boolean' },
      },
    });
  });

  it('maps auth helpers to security schemes (collection key, bearer override, noauth opt-out)', () => {
    expect(parsed.securitySchemeDetails['ApiKey_X_API_Key']).toEqual({
      type: 'apiKey', in: 'header', name: 'X-API-Key',
    });
    expect(parsed.securitySchemeTypes['BearerAuth']).toBe('http');
    expect(op(parsed, 'listInvoices').authSchemes).toEqual(['ApiKey_X_API_Key']);
    expect(op(parsed, 'createInvoice').authSchemes).toEqual(['BearerAuth']);
    // noauth is explicit: the operation drops the inherited collection key.
    const del = op(parsed, 'deleteInvoice');
    expect(del.authSchemes).toEqual([]);
  });

  it('compiles into tools with body args and credential modes (no re-derivation)', () => {
    const create = op(parsed, 'createInvoice');
    const tool = compileOperation(create, parsed.baseUrl, 'postman', parsed.securitySchemeTypes, parsed.securitySchemeDetails);
    expect(tool.name).toBe('createInvoice');
    expect(tool.credential_mode).toBe('api_key');
    const props = (tool.input_schema as any).properties;
    expect(props.customer).toMatchObject({ type: 'string' });
    expect(props.amount).toMatchObject({ type: 'integer' });
    expect((tool.upstream as any).param_bindings).toEqual(expect.arrayContaining([
      { arg: 'customer', location: 'body', target: 'customer' },
    ]));
  });
});

describe('convertPostmanToOpenApi', () => {
  it('keeps form bodies faithful (urlencoded fields, disabled skipped)', () => {
    const out = convertPostmanToOpenApi(JSON.parse(JSON.stringify(COLLECTION)));
    const login = out.paths['/v1/login'].post;
    expect(login.requestBody.content['application/x-www-form-urlencoded'].schema).toEqual({
      type: 'object',
      properties: { user: { type: 'string' }, pass: { type: 'string' } },
    });
  });

  it('detects collections and passes non-collections through untouched', () => {
    expect(isPostmanCollection(COLLECTION)).toBe(true);
    expect(isPostmanCollection({ openapi: '3.0.3', paths: {} })).toBe(false);
    const doc = { openapi: '3.0.3', paths: {} };
    expect(convertPostmanToOpenApi(doc)).toBe(doc);
  });

  it('never mutates the source collection', () => {
    const src = JSON.parse(JSON.stringify(COLLECTION));
    const before = JSON.stringify(src);
    convertPostmanToOpenApi(src);
    expect(JSON.stringify(src)).toBe(before);
  });

  it('deduplicates operationIds derived from repeated request names', () => {
    const dup = JSON.parse(JSON.stringify(COLLECTION));
    dup.item[1].item[0].name = 'List invoices';
    const out = convertPostmanToOpenApi(dup);
    const ids = Object.values<any>(out.paths).flatMap((p: any) => Object.values<any>(p).map((o: any) => o.operationId));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('fails loudly on a collection with no requests', () => {
    const empty = { info: { name: 'Empty', schema: COLLECTION.info.schema }, item: [{ name: 'Folder', item: [] }] };
    expect(() => parseOpenApi(empty)).toThrow(/no requests/i);
  });
});
