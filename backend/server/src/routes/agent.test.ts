// EV-08 agent tasks + HK-09 suggestions routes, with a scripted model.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const txQuery = vi.fn();
vi.mock('../db.js', () => ({
  one: vi.fn(),
  q: vi.fn(),
  exec: vi.fn(),
  withTx: vi.fn(async (fn: any) => fn({ query: txQuery })),
  J: { parse: (v: any, fb: any) => (v == null ? fb : typeof v === 'string' ? JSON.parse(v) : v) },
  jb: (v: unknown) => JSON.stringify(v),
  uid: (() => { let n = 0; return () => `uid-${++n}`; })(),
  audit: vi.fn(),
}));
vi.mock('../auth.js', () => ({
  requireProjectRole: () => (_req: any, _res: any, next: any) => next(),
  requireProjectRead: () => (_req: any, _res: any, next: any) => next(),
}));

import { one, q, exec } from '../db.js';
import { setLlmClient, type LlmClient } from '../llm/index.js';
import { errorHandler } from '../errors.js';
import { agentRouter } from './agent.js';
import { suggestionsRouter } from './suggestions.js';

const oneMock = vi.mocked(one);
const qMock = vi.mocked(q);
const execMock = vi.mocked(exec);

function app() {
  const a = express();
  a.use(express.json());
  a.use((req: any, _res, next) => { req.auth = { userId: 'u1', memberships: [] }; next(); });
  a.use('/v1/projects', agentRouter);
  a.use('/v1/projects', suggestionsRouter);
  a.use(errorHandler);
  return a;
}

const answerWith = (text: string): LlmClient => ({
  provider: 'fake', model: 'f',
  chat: async () => ({ text, toolCalls: [], usage: { inputTokens: 5, outputTokens: 5 }, stopReason: 'end', provider: 'fake', model: 'f' }),
});

const toolRow = {
  id: 't1', name: 'searchItems', description: 'Search.', eligible_use: null, ineligible_use: null, status: 'approved',
  effect_classes: '["read_only"]', input_schema: JSON.stringify({ type: 'object', properties: { q: { type: 'string', description: 'Query' } } }),
};

beforeEach(() => {
  vi.clearAllMocks();
  execMock.mockResolvedValue(1);
  qMock.mockResolvedValue([]);
  oneMock.mockResolvedValue(undefined);
});
afterEach(() => setLlmClient(undefined));

describe('agent tasks', () => {
  it('503s generate when no model is configured', async () => {
    setLlmClient(null);
    const res = await request(app()).post('/v1/projects/p1/agent-tasks/generate');
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('llm_not_configured');
  });

  it('stores model-proposed tasks as proposed, never approved', async () => {
    setLlmClient(answerWith('[{"prompt":"Find blue mugs","expected_tools":["searchItems"],"forbidden_tools":[],"answer_rubric":"names mugs"}]'));
    qMock.mockResolvedValueOnce([toolRow]).mockResolvedValueOnce([{ id: 'uid-1', prompt: 'Find blue mugs', expected_tools: '["searchItems"]', forbidden_tools: '[]', status: 'proposed' }]);
    oneMock.mockResolvedValueOnce({ name: 'Shop API' });
    const res = await request(app()).post('/v1/projects/p1/agent-tasks/generate');
    expect(res.status).toBe(201);
    const insert = execMock.mock.calls.find((c) => String(c[0]).includes('INSERT INTO eval_agent_tasks'))!;
    expect(String(insert[0])).toContain("'llm', 'proposed'");
    expect(insert[1]).toEqual(['uid-1', 'p1', 'Find blue mugs', '["searchItems"]', '[]', 'names mugs', 'fake/f']);
    expect(res.body.tasks[0].expected_tools).toEqual(['searchItems']);
  });

  it('owner-written tasks are approved at once; patch scopes by project', async () => {
    oneMock.mockResolvedValue({ id: 'uid-9', prompt: 'x', expected_tools: '[]', forbidden_tools: '[]' });
    const created = await request(app()).post('/v1/projects/p1/agent-tasks').send({ prompt: 'List my items' });
    expect(created.status).toBe(201);
    expect(String(execMock.mock.calls[0]![0])).toContain("'owner', 'approved'");

    execMock.mockResolvedValueOnce(0);
    const missing = await request(app()).patch('/v1/projects/p1/agent-tasks/other').send({ status: 'approved' });
    expect(missing.status).toBe(404);
  });
});

describe('suggestions', () => {
  it('returns no suggestions (and asks no model) when there is no evidence', async () => {
    const chat = vi.fn();
    setLlmClient({ provider: 'fake', model: 'f', chat });
    qMock.mockResolvedValueOnce([toolRow]); // tools; evidence queries default to []
    const res = await request(app()).post('/v1/projects/p1/suggestions/generate');
    expect(res.status).toBe(200);
    expect(res.body.suggestions).toEqual([]);
    expect(chat).not.toHaveBeenCalled();
  });

  it('accept applies a param description and sends the tool back for approval', async () => {
    oneMock.mockResolvedValueOnce({ id: 's1', project_id: 'p1', tool_id: 't1', field: 'param_description', param: 'q', after_text: 'Keywords', status: 'proposed' });
    txQuery.mockResolvedValueOnce({ rows: [{ input_schema: toolRow.input_schema }] }).mockResolvedValue({ rows: [] });
    const res = await request(app()).post('/v1/projects/p1/suggestions/s1/accept').send({});
    expect(res.status).toBe(200);
    const update = txQuery.mock.calls.find((c) => String(c[0]).includes('UPDATE canonical_tools'))!;
    expect(String(update[0])).toContain("status = 'candidate'");
    expect(JSON.parse(update[1][0]).properties.q.description).toBe('Keywords');
  });

  it('409s a suggestion that was already decided', async () => {
    oneMock.mockResolvedValueOnce({ id: 's1', status: 'rejected' });
    const res = await request(app()).post('/v1/projects/p1/suggestions/s1/accept').send({});
    expect(res.status).toBe(409);
  });
});
