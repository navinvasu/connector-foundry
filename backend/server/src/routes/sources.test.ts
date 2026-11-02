// IA-04 route acceptance: POST /v1/projects/:id/sources with a broken
// spec returns 400 with exactly what's wrong and where (pointer + ref +
// repair suggestion, line numbers for raw-text imports) — and stores
// nothing. A sound spec still imports as before.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('../db.js', () => ({
  one: vi.fn(),
  q: vi.fn(),
  exec: vi.fn(),
  withTx: vi.fn(),
  J: {
    parse: (v: any, fb: any) =>
      v == null ? fb : typeof v === 'string' ? JSON.parse(v) : v,
    str: (v: any) => JSON.stringify(v ?? null),
  },
  jb: (v: unknown) => JSON.stringify(v),
  uid: () => 'uid-1',
  audit: vi.fn(),
}));

vi.mock('../queue.js', () => ({
  enqueueJob: vi.fn(async () => ({ job: { id: 'job-1', status: 'queued' }, deduplicated: false })),
}));

import { one, withTx, audit } from '../db.js';
import { enqueueJob } from '../queue.js';
import { sourcesRouter } from './sources.js';
import { errorHandler } from '../errors.js';

const enqueueJobMock = vi.mocked(enqueueJob);

const oneMock = vi.mocked(one);
const withTxMock = vi.mocked(withTx);
const auditMock = vi.mocked(audit);
const txQuery = vi.fn();
// Real pg answers INSERT..RETURNING with the inserted rows; every other
// write in the import transaction returns nothing the route reads.
const freshInsertRows = () => ({ rows: [{ id: 'uid-1' }] });

const membership = {
  customerId: 'c1', customerName: 'X', customerStatus: 'active', planId: 'starter',
  planName: 'Starter', seatCap: 3, projectCap: 5, telemetryRetentionDays: 90,
  trialEndsAt: null, pastDueSince: null, role: 'owner', membershipStatus: 'active',
};

function app() {
  const a = express();
  a.use(express.json());
  a.use((req: any, _res, next) => {
    req.auth = {
      userId: 'u1', email: 'o@x.test', fullName: null, isPlatformAdmin: false,
      memberships: [membership],
    };
    next();
  });
  a.use('/v1/projects', sourcesRouter);
  a.use(errorHandler);
  return a;
}

const goodSpec = {
  openapi: '3.0.3',
  info: { title: 'Pet Store', version: '1.0.0' },
  servers: [{ url: 'https://pets.test/v1' }],
  paths: {
    '/pets': {
      get: {
        operationId: 'listPets',
        summary: 'List pets',
        responses: {
          '200': {
            description: 'ok',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } },
          },
        },
      },
    },
  },
  components: { schemas: { Pet: { type: 'object', properties: { name: { type: 'string' } } } } },
};

beforeEach(() => {
  vi.clearAllMocks();
  txQuery.mockImplementation(async (sql: string) =>
    String(sql).includes('RETURNING id') ? freshInsertRows() : undefined,
  );
  oneMock.mockResolvedValue({ id: 'p1', customer_id: 'c1' } as any);
  withTxMock.mockImplementation(async (fn: any) => fn({ query: txQuery }));
});

describe('POST /v1/projects/:id/sources — IA-04 validation', () => {
  it('the AC: a bad $ref returns exactly what is wrong and where, and stores nothing', async () => {
    const bad = structuredClone(goodSpec) as any;
    bad.paths['/pets'].get.responses['200'].content['application/json'].schema.$ref =
      '#/components/schemas/Pets';
    const res = await request(app())
      .post('/v1/projects/p1/sources')
      .send({ type: 'openapi_json', payload: bad });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('spec_validation_error');
    expect(res.body.request_id).toBeTruthy();
    expect(res.body.issues).toHaveLength(1);
    const issue = res.body.issues[0];
    expect(issue.ref).toBe('#/components/schemas/Pets');
    expect(issue.pointer).toBe(
      '/paths/~1pets/get/responses/200/content/application~1json/schema/$ref',
    );
    expect(issue.message).toMatch(/does not resolve/);
    expect(issue.suggestion).toBe('#/components/schemas/Pet');
    expect(withTxMock).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('raw-text imports carry the line number of the offending ref', async () => {
    const text = [
      '{',
      '  "openapi": "3.0.3",',
      '  "info": { "title": "T", "version": "1" },',
      '  "paths": { "/x": { "get": { "responses": { "200": { "description": "ok",',
      '    "content": { "application/json": { "schema": { "$ref": "#/components/schemas/Gone" } } } } } } } },',
      '  "components": { "schemas": {} }',
      '}',
    ].join('\n');
    const res = await request(app())
      .post('/v1/projects/p1/sources')
      .send({ type: 'openapi_text', payload: text });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('spec_validation_error');
    expect(res.body.issues[0].ref).toBe('#/components/schemas/Gone');
    expect(res.body.issues[0].line).toBe(5);
  });

  it('a YAML text import with a bad ref is located by line too', async () => {
    const yaml = [
      'openapi: 3.0.3',
      'info: { title: T, version: "1" }',
      'paths:',
      '  /x:',
      '    get:',
      '      responses:',
      '        "200":',
      '          description: ok',
      '          content:',
      '            application/json:',
      '              schema: { $ref: "#/components/schemas/Gone" }',
      'components: { schemas: {} }',
    ].join('\n');
    const res = await request(app())
      .post('/v1/projects/p1/sources')
      .send({ type: 'openapi_text', payload: yaml });
    expect(res.status).toBe(400);
    expect(res.body.issues[0].line).toBe(11);
  });

  it('external refs are rejected with the inline-it repair', async () => {
    const bad = structuredClone(goodSpec) as any;
    bad.paths['/pets'].get.responses['200'].content['application/json'].schema.$ref =
      'https://example.com/common.yaml#/components/schemas/Pet';
    const res = await request(app())
      .post('/v1/projects/p1/sources')
      .send({ type: 'openapi_json', payload: bad });
    expect(res.status).toBe(400);
    expect(res.body.issues[0].message).toMatch(/inline the target/);
    expect(withTxMock).not.toHaveBeenCalled();
  });

  it('a sound spec still imports (201, operations counted, source stored)', async () => {
    const res = await request(app())
      .post('/v1/projects/p1/sources')
      .send({ type: 'openapi_json', payload: goodSpec });
    expect(res.status).toBe(201);
    expect(res.body.source.operations).toBe(1);
    expect(res.body.source.title).toBe('Pet Store');
    expect(withTxMock).toHaveBeenCalledTimes(1);
  });

  it('non-ref parse failures keep the existing spec_parse_error shape', async () => {
    const res = await request(app())
      .post('/v1/projects/p1/sources')
      .send({ type: 'openapi_json', payload: { openapi: '9.9', paths: {} } });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('spec_parse_error');
    expect(res.body.error).toMatch(/Unsupported spec version/);
  });

  it('IA-02: a Postman collection imports as a postman source with its operations', async () => {
    const collection = {
      info: {
        name: 'Pets (Postman)',
        schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
      },
      item: [
        {
          name: 'List pets',
          request: {
            method: 'GET',
            url: { raw: 'https://pets.test/v1/pets?limit=5' },
          },
        },
      ],
    };
    const res = await request(app())
      .post('/v1/projects/p1/sources')
      .send({ type: 'postman_json', payload: collection });
    expect(res.status).toBe(201);
    expect(res.body.source.title).toBe('Pets (Postman)');
    expect(res.body.source.operations).toBe(1);
    expect(res.body.inventory.operations[0]).toMatchObject({ method: 'GET', path: '/v1/pets' });
    // The stored source carries the real provenance type.
    const insert = txQuery.mock.calls.find((c: any[]) => String(c[0]).includes('INSERT INTO api_sources'));
    expect(insert?.[1]?.[2]).toBe('postman');
  });

  it('enqueues a compile job with the import so compilation starts at once', async () => {
    const res = await request(app())
      .post('/v1/projects/p1/sources')
      .send({ type: 'openapi_json', payload: goodSpec });
    expect(res.status).toBe(201);
    expect(enqueueJobMock).toHaveBeenCalledWith('compile', 'p1', 'u1');
    expect(res.body.compile_job).toMatchObject({ id: 'job-1', status: 'queued' });
  });

  it('re-importing the same spec adds no rows and skips the compile', async () => {
    // Every operation collides with the existing row: RETURNING comes back
    // empty, so there is nothing new to compile.
    txQuery.mockImplementation(async () => ({ rows: [] }));
    const res = await request(app())
      .post('/v1/projects/p1/sources')
      .send({ type: 'openapi_json', payload: goodSpec });
    expect(res.status).toBe(201);
    expect(res.body.source.operations).toBe(1);
    expect(enqueueJobMock).not.toHaveBeenCalled();
    expect(res.body.compile_job).toBeNull();
  });

  it('operation and review inserts collide instead of duplicating', async () => {
    await request(app())
      .post('/v1/projects/p1/sources')
      .send({ type: 'openapi_json', payload: goodSpec });
    const opInsert = txQuery.mock.calls.find((c: any[]) => String(c[0]).includes('INSERT INTO operations'));
    const reviewInsert = txQuery.mock.calls.find((c: any[]) => String(c[0]).includes('INSERT INTO review_items'));
    expect(opInsert?.[0]).toMatch(/ON CONFLICT DO NOTHING/);
    expect(reviewInsert?.[0]).toMatch(/ON CONFLICT DO NOTHING/);
  });
});
