import { describe, it, expect } from 'vitest';
import { compileOperation } from './compiler.js';
import type { ParsedOperation } from './openapi.js';

function op(over: Partial<ParsedOperation> = {}): ParsedOperation {
  return {
    method: 'GET',
    path: '/invoices',
    operationId: undefined,
    summary: 'List invoices',
    description: '',
    parameters: [],
    requestBodySchema: undefined,
    responseCodes: ['200'],
    hasErrorResponses: false,
    deprecated: false,
    authSchemes: [],
    authScopes: [],
    tags: [],
    ...over,
  };
}

describe('compileOperation', () => {
  it('derives a camelCase name from operationId', () => {
    const t = compileOperation(op({ operationId: 'list_invoices' }), 'https://api.test', 'spec#1');
    expect(t.name).toBe('listInvoices');
  });

  it('derives a name from method+path when there is no operationId', () => {
    const t = compileOperation(op({ method: 'GET', path: '/v1/invoices' }), 'https://api.test', 'spec#1');
    expect(t.name).toBe('getInvoices');
    const t2 = compileOperation(op({ method: 'POST', path: '/invoices' }), 'https://api.test', 'spec#1');
    expect(t2.name).toBe('createInvoices');
  });

  it('classifies GET as read_only with no confirmation requirement', () => {
    const t = compileOperation(op({ method: 'GET', path: '/invoices' }), 'https://api.test', 's');
    expect(t.effect_classes).toEqual(['read_only']);
    expect(t.confirmation_required).toBe(false);
    expect(t.idempotent).toBe(true);
  });

  it('requires confirmation for mutating operations', () => {
    const t = compileOperation(op({ method: 'POST', path: '/invoices' }), 'https://api.test', 's');
    expect(t.effect_classes).toEqual(['mutating']);
    expect(t.confirmation_required).toBe(true);
    const d = compileOperation(op({ method: 'DELETE', path: '/invoices/1' }), 'https://api.test', 's');
    expect(d.effect_classes).toEqual(['destructive']);
    expect(d.confirmation_required).toBe(true);
  });

  it('maps parameters to input schema + upstream bindings', () => {
    const t = compileOperation(op({
      parameters: [
        { name: 'limit', location: 'query', required: false, type: 'integer', description: 'Page size', default: 20, example: undefined },
        { name: 'id', location: 'path', required: true, type: 'string', description: '', default: undefined, example: undefined },
      ],
    }), 'https://api.test', 's');
    const schema = t.input_schema as any;
    expect(schema.properties.limit.type).toBe('integer');
    expect(schema.properties.limit.default).toBe(20);
    expect(schema.required).toEqual(['id']);
    const up = t.upstream as any;
    expect(up.param_bindings).toEqual([
      { arg: 'limit', location: 'query', target: 'limit' },
      { arg: 'id', location: 'path', target: 'id' },
    ]);
  });

  it('attaches the four default recovery rules', () => {
    const t = compileOperation(op(), 'https://api.test', 's');
    expect(t.recovery_rules.map((r) => r.condition)).toEqual(
      ['RATE_LIMITED', 'UPSTREAM_ERROR', 'BAD_REQUEST', 'EMPTY_RESULT']);
  });

  it('records spec + rule provenance and a doc confidence score', () => {
    const t = compileOperation(op({ method: 'GET', path: '/invoices' }), 'https://api.test', 'acme.yaml');
    expect(t.provenance).toContainEqual({ kind: 'spec', ref: 'acme.yaml#GET /invoices' });
    expect(t.confidence).toBeGreaterThanOrEqual(0);
    expect(t.confidence).toBeLessThanOrEqual(100);
  });
});

describe('compileOperation credential_mode (AB-05)', () => {
  it('is none with no required scopes when the operation needs no auth', () => {
    const t = compileOperation(op(), 'https://api.test', 's', { ApiKeyAuth: 'apiKey' });
    expect(t.credential_mode).toBe('none');
    expect(t.required_scopes).toEqual([]);
  });

  it('maps an apiKey scheme to api_key', () => {
    const t = compileOperation(op({ authSchemes: ['ApiKeyAuth'] }), 'https://api.test', 's', { ApiKeyAuth: 'apiKey' });
    expect(t.credential_mode).toBe('api_key');
    expect(t.required_scopes).toEqual([]);
    expect(t.provenance).toContainEqual({ kind: 'rule', ref: 'credential-mode-v1 (spec security → api_key)' });
  });

  it('maps http bearer/basic schemes to api_key (static credential)', () => {
    const t = compileOperation(op({ authSchemes: ['BearerAuth'] }), 'https://api.test', 's', { BearerAuth: 'http' });
    expect(t.credential_mode).toBe('api_key');
  });

  it('maps oauth2 to oauth and carries the required scopes', () => {
    const t = compileOperation(
      op({ authSchemes: ['OAuth'], authScopes: ['read', 'write', 'read'] }),
      'https://api.test', 's', { OAuth: 'oauth2' });
    expect(t.credential_mode).toBe('oauth');
    expect(t.required_scopes).toEqual(['read', 'write']);
  });

  it('maps openIdConnect to oauth', () => {
    const t = compileOperation(op({ authSchemes: ['Oidc'] }), 'https://api.test', 's', { Oidc: 'openIdConnect' });
    expect(t.credential_mode).toBe('oauth');
  });

  it('oauth wins when several schemes apply', () => {
    const t = compileOperation(
      op({ authSchemes: ['ApiKeyAuth', 'OAuth'], authScopes: ['read'] }),
      'https://api.test', 's', { ApiKeyAuth: 'apiKey', OAuth: 'oauth2' });
    expect(t.credential_mode).toBe('oauth');
  });

  it('treats a required-but-undefined scheme as api_key (auth is required, kind unknown)', () => {
    const t = compileOperation(op({ authSchemes: ['Mystery'] }), 'https://api.test', 's', {});
    expect(t.credential_mode).toBe('api_key');
  });
});

describe('compileOperation auth_injection (AB-02)', () => {
  const types = {
    ApiKeyAuth: 'apiKey', QueryKey: 'apiKey', CookieKey: 'apiKey',
    BearerAuth: 'http', BasicAuth: 'http', LegacyBasic: 'basic',
  };
  const details = {
    ApiKeyAuth: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
    QueryKey: { type: 'apiKey', in: 'query', name: 'api_key' },
    CookieKey: { type: 'apiKey', in: 'cookie', name: 'sess' },
    BearerAuth: { type: 'http', scheme: 'bearer' },
    BasicAuth: { type: 'http', scheme: 'basic' },
    LegacyBasic: { type: 'basic' },
  };

  it('freezes header apiKey injection into the snapshot', () => {
    const t = compileOperation(op({ authSchemes: ['ApiKeyAuth'] }), 'https://api.test', 's', types, details);
    expect((t.upstream as any).auth_injection).toEqual({ location: 'header', name: 'X-API-Key' });
  });

  it('freezes query apiKey injection into the snapshot', () => {
    const t = compileOperation(op({ authSchemes: ['QueryKey'] }), 'https://api.test', 's', types, details);
    expect((t.upstream as any).auth_injection).toEqual({ location: 'query', name: 'api_key' });
  });

  it('freezes cookie apiKey as a Cookie header', () => {
    const t = compileOperation(op({ authSchemes: ['CookieKey'] }), 'https://api.test', 's', types, details);
    expect((t.upstream as any).auth_injection).toEqual({ location: 'header', name: 'Cookie', cookieName: 'sess' });
  });

  it('freezes http bearer / http basic / swagger basic schemes', () => {
    const b = compileOperation(op({ authSchemes: ['BearerAuth'] }), 'https://api.test', 's', types, details);
    expect((b.upstream as any).auth_injection).toEqual({ location: 'header', name: 'Authorization', scheme: 'bearer' });
    const hb = compileOperation(op({ authSchemes: ['BasicAuth'] }), 'https://api.test', 's', types, details);
    expect((hb.upstream as any).auth_injection).toEqual({ location: 'header', name: 'Authorization', scheme: 'basic' });
    const lb = compileOperation(op({ authSchemes: ['LegacyBasic'] }), 'https://api.test', 's', types, details);
    expect((lb.upstream as any).auth_injection).toEqual({ location: 'header', name: 'Authorization', scheme: 'basic' });
  });

  it('omits auth_injection for non-api_key tools', () => {
    const t = compileOperation(op(), 'https://api.test', 's', types, details);
    expect((t.upstream as any).auth_injection).toBeUndefined();
    const o = compileOperation(op({ authSchemes: ['OAuth'] }), 'https://api.test', 's', { ...types, OAuth: 'oauth2' }, details);
    expect(o.credential_mode).toBe('oauth');
    expect((o.upstream as any).auth_injection).toBeUndefined();
  });

  it('defaults a required-but-undefined scheme to the X-API-Key header', () => {
    const t = compileOperation(op({ authSchemes: ['Mystery'] }), 'https://api.test', 's', {});
    expect(t.credential_mode).toBe('api_key');
    expect((t.upstream as any).auth_injection).toEqual({ location: 'header', name: 'X-API-Key' });
  });
});

describe('compileOperation request bodies (BE-16)', () => {
  const bodyOp = (over: Partial<ParsedOperation> = {}) => op({
    method: 'POST',
    path: '/widgets',
    operationId: 'create_widget',
    summary: 'Create a widget',
    requestBodySchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Widget name' },
        display_count: { type: 'integer' },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['name'],
    },
    ...over,
  });

  it('merges body-schema properties into input_schema with body bindings', () => {
    const t = compileOperation(bodyOp(), 'https://api.test', 's');
    const schema = t.input_schema as any;
    expect(Object.keys(schema.properties).sort()).toEqual(['displayCount', 'name', 'tags']);
    expect(schema.properties.name).toMatchObject({ type: 'string', description: 'Widget name' });
    expect(schema.properties.tags).toMatchObject({ type: 'array', items: { type: 'string' } });
    expect(schema.required).toEqual(['name']);
    const bindings = (t.upstream as any).param_bindings;
    expect(bindings).toContainEqual({ arg: 'name', location: 'body', target: 'name' });
    expect(bindings).toContainEqual({ arg: 'displayCount', location: 'body', target: 'display_count' });
    expect(t.provenance.some((p) => p.ref.includes('request-body-v1'))).toBe(true);
  });

  it('merges parameters and body fields side by side', () => {
    const t = compileOperation(bodyOp({
      parameters: [{ name: 'id', location: 'path', required: true, type: 'string', description: '', default: undefined, example: undefined }],
    }), 'https://api.test', 's');
    const schema = t.input_schema as any;
    expect(schema.properties.id).toBeDefined();
    expect(schema.properties.name).toBeDefined();
    expect(schema.required.sort()).toEqual(['id', 'name']);
  });

  it('renames a body arg that collides with a parameter arg', () => {
    const t = compileOperation(bodyOp({
      parameters: [{ name: 'name', location: 'query', required: false, type: 'string', description: '', default: undefined, example: undefined }],
    }), 'https://api.test', 's');
    const schema = t.input_schema as any;
    expect(schema.properties.name).toBeDefined();
    expect(schema.properties.bodyName).toBeDefined();
    const bindings = (t.upstream as any).param_bindings;
    expect(bindings).toContainEqual({ arg: 'name', location: 'query', target: 'name' });
    expect(bindings).toContainEqual({ arg: 'bodyName', location: 'body', target: 'name' });
    expect(schema.required).toEqual(['bodyName']);
  });

  it('keeps nested object property schemas intact for the output adapters', () => {
    const t = compileOperation(bodyOp({
      requestBodySchema: {
        type: 'object',
        properties: {
          address: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
        },
      },
    }), 'https://api.test', 's');
    const schema = t.input_schema as any;
    expect(schema.properties.address).toMatchObject({
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city'],
    });
  });

  it('compiles a free-form object body to a single whole-body arg', () => {
    const t = compileOperation(bodyOp({ requestBodySchema: { type: 'object' } }), 'https://api.test', 's');
    const schema = t.input_schema as any;
    expect(schema.properties.body).toMatchObject({ type: 'object' });
    expect((t.upstream as any).param_bindings).toEqual([{ arg: 'body', location: 'body', target: '' }]);
  });

  it('compiles a $ref body schema to a whole-body arg (no local deref in v1)', () => {
    const t = compileOperation(bodyOp({
      requestBodySchema: { $ref: '#/components/schemas/Widget' },
    }), 'https://api.test', 's');
    const schema = t.input_schema as any;
    expect(schema.properties.body).toMatchObject({ type: 'object' });
    expect((t.upstream as any).param_bindings).toEqual([{ arg: 'body', location: 'body', target: '' }]);
  });

  it('compiles an array body schema to a whole-body array arg', () => {
    const t = compileOperation(bodyOp({
      requestBodySchema: { type: 'array', items: { type: 'string' } },
    }), 'https://api.test', 's');
    const schema = t.input_schema as any;
    expect(schema.properties.body).toMatchObject({ type: 'array' });
    expect((t.upstream as any).param_bindings).toEqual([{ arg: 'body', location: 'body', target: '' }]);
  });

  it('adds no body bindings when the operation has no request body', () => {
    const t = compileOperation(op({ method: 'GET', path: '/widgets' }), 'https://api.test', 's');
    const bindings = (t.upstream as any).param_bindings;
    expect(bindings.every((b: any) => b.location !== 'body')).toBe(true);
    expect(t.provenance.some((p) => p.ref.includes('request-body-v1'))).toBe(false);
  });
});
