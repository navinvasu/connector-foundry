// RL-04: OpenAI output artifacts — function-calling tools + GPT Actions
// OpenAPI generated from frozen release snapshots. Pure builders and
// validators; DB access is mocked (route-level coverage lives in
// routes/openai.test.ts).
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./db.js', () => ({
  one: vi.fn(),
  q: vi.fn(),
  J: { parse: (v: any, fb: any) => (v == null ? fb : typeof v === 'string' ? JSON.parse(v) : v) },
}));

import { one, q } from './db.js';
import {
  sanitizeOpenAiName, dedupeNames, toParametersSchema, toOpenAiFunction,
  buildOpenAiTools, validateOpenAiTools, isConsequential,
  buildGptActionsOpenApi, validateGptActionsOpenApi, loadReleaseSnapshots,
} from './openai-artifacts.js';

const oneMock = vi.mocked(one);
const qMock = vi.mocked(q);

const forecast = {
  name: 'getForecast', description: 'Get the forecast for a city',
  input_schema: {
    type: 'object',
    properties: { city: { type: 'string' }, days: { type: 'integer' } },
    required: ['city'],
  },
  effect_classes: ['read_only'], confirmation_required: false,
};
const createOrder = {
  name: 'createOrder', description: 'Create an order',
  input_schema: { type: 'object', properties: { sku: { type: 'string' } }, required: ['sku'] },
  effect_classes: ['mutating'], confirmation_required: true,
};

describe('sanitizeOpenAiName + dedupeNames', () => {
  it('keeps valid names and repairs invalid ones', () => {
    expect(sanitizeOpenAiName('getForecast')).toBe('getForecast');
    expect(sanitizeOpenAiName('get forecast!')).toBe('get_forecast');
    expect(sanitizeOpenAiName('')).toBe('tool');
    expect(sanitizeOpenAiName('x'.repeat(80))).toHaveLength(64);
  });

  it('dedupes collisions with numeric suffixes inside the cap', () => {
    expect(dedupeNames(['a', 'a', 'a'])).toEqual(['a', 'a_2', 'a_3']);
  });
});

describe('toParametersSchema / toOpenAiFunction', () => {
  it('normalizes the envelope and keeps property schemas verbatim', () => {
    expect(toParametersSchema({ properties: { a: { type: 'string' } } }))
      .toEqual({ type: 'object', properties: { a: { type: 'string' } } });
    expect(toParametersSchema(null)).toEqual({ type: 'object', properties: {} });
    expect(toParametersSchema({ $schema: 'http://json-schema.org/draft-07/schema#', type: 'object' }))
      .toEqual({ type: 'object', properties: {} });
  });

  it('builds a spec-shaped function tool with strict off', () => {
    const tool = toOpenAiFunction(forecast);
    expect(tool).toEqual({
      type: 'function',
      function: {
        name: 'getForecast',
        description: 'Get the forecast for a city',
        parameters: forecast.input_schema,
        strict: false,
      },
    });
  });
});

describe('validateOpenAiTools (the function-calling AC)', () => {
  it('accepts artifacts built from frozen snapshots', () => {
    expect(validateOpenAiTools(buildOpenAiTools([forecast, createOrder]))).toEqual([]);
  });

  it('flags bad names, duplicates, empty descriptions, and non-object parameters', () => {
    const issues = validateOpenAiTools([
      { type: 'function', function: { name: 'bad name!', description: 'x', parameters: { type: 'object' } } },
      { type: 'function', function: { name: 'bad name!', description: '', parameters: { type: 'array' } } },
    ]);
    expect(issues.map((i) => i.path)).toEqual(expect.arrayContaining([
      'tools[0].function.name', 'tools[1].function.name',
      'tools[1].function.description', 'tools[1].function.parameters.type',
    ]));
  });

  it('refuses artifacts carrying gateway-key material', () => {
    const leaky = [{
      type: 'function',
      function: { name: 'ok', description: 'cf_live_abcdefgh12345678', parameters: { type: 'object' } },
    }];
    expect(validateOpenAiTools(leaky as any).some((i) => i.message.includes('gateway-key'))).toBe(true);
  });
});

describe('GPT Actions OpenAPI', () => {
  const ctx = {
    connectorName: 'Weather-connector', version: '1.0.0',
    description: 'Agent connector for Weather',
    serverUrl: 'https://api.example.com/v1/gpt-actions/p1/1.0.0',
  };

  it('marks read-only tools non-consequential and writes consequential', () => {
    expect(isConsequential(forecast)).toBe(false);
    expect(isConsequential(createOrder)).toBe(true);
    expect(isConsequential({ effect_classes: ['destructive'] })).toBe(true);
  });

  it('builds an importable document: one operation per tool, key scheme applied', () => {
    const doc = buildGptActionsOpenApi(ctx, [forecast, createOrder]) as any;
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.servers).toEqual([{ url: ctx.serverUrl }]);
    expect(Object.keys(doc.paths).sort()).toEqual(['/createOrder', '/getForecast']);
    const get = doc.paths['/getForecast'].post;
    expect(get.operationId).toBe('getForecast');
    expect(get['x-openai-isConsequential']).toBe(false);
    expect(get.requestBody.content['application/json'].schema).toEqual(forecast.input_schema);
    expect(get.security).toEqual([{ GatewayKey: [] }]);
    expect(doc.components.securitySchemes.GatewayKey).toMatchObject({ type: 'apiKey', in: 'header', name: 'X-API-Key' });
    expect(doc.paths['/createOrder'].post['x-openai-isConsequential']).toBe(true);
    expect(validateGptActionsOpenApi(doc)).toEqual([]);
  });

  it('validator catches duplicate operationIds, missing 200s, and external refs', () => {
    const issues = validateGptActionsOpenApi({
      openapi: '3.1.0',
      info: { title: 'x', version: '1' },
      servers: [{ url: 'https://x' }],
      paths: {
        '/a': { post: { operationId: 'dup', responses: {} } },
        '/b': { post: { operationId: 'dup', responses: { '200': {} }, requestBody: { content: { 'application/json': { schema: { $ref: 'https://evil.example/x.json' } } } } } },
      },
      components: { securitySchemes: { GatewayKey: {} } },
    });
    const messages = issues.map((i) => i.message).join(' ');
    expect(messages).toContain('duplicate operationId');
    expect(messages).toContain('a 200 response is required');
    expect(messages).toContain('external $ref');
  });
});

describe('loadReleaseSnapshots', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    oneMock.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM releases')) return { id: 'r1', project_id: 'p1', version: '1.0.0', status: 'approved' };
      if (sql.includes('FROM projects')) return { name: 'Weather' };
      return undefined;
    });
    qMock.mockResolvedValue([{ tool_snapshot: forecast }, { tool_snapshot: JSON.stringify(createOrder) }]);
  });

  it('loads frozen snapshots ordered by tool name (string snapshots parsed)', async () => {
    const rel = await loadReleaseSnapshots('r1');
    expect(rel).toMatchObject({ releaseId: 'r1', projectId: 'p1', version: '1.0.0', connectorName: 'Weather-connector' });
    expect(rel.snapshots).toHaveLength(2);
    expect(rel.snapshots[1].name).toBe('createOrder');
    expect(String(qMock.mock.calls[0][0])).toContain("ORDER BY tool_snapshot->>'name'");
  });

  it('404s an unknown release and 409s a deprecated one', async () => {
    oneMock.mockResolvedValueOnce(undefined);
    await expect(loadReleaseSnapshots('nope')).rejects.toMatchObject({ status: 404, code: 'release_not_found' });

    oneMock.mockImplementation(async (sql: string) =>
      sql.includes('FROM releases') ? { id: 'r2', project_id: 'p1', version: '0.9.0', status: 'deprecated' } : undefined);
    await expect(loadReleaseSnapshots('r2')).rejects.toMatchObject({ status: 409, code: 'release_deprecated' });
  });
});
