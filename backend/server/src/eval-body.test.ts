// BE-16: eval probes must exercise a write tool the way invoke will serve
// it — real method, real JSON body — or a POST tool can never honestly
// pass (and a GET-shaped probe would certify nothing).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./db.js', () => ({
  one: vi.fn(),
  q: vi.fn(),
  exec: vi.fn(),
  J: {
    parse: (v: any, fb: any) =>
      v == null ? fb : typeof v === 'string' ? JSON.parse(v) : v,
  },
  jb: (v: unknown) => JSON.stringify(v),
  uid: (() => { let n = 0; return () => `uid-${++n}`; })(),
}));

import { q } from './db.js';
import { runEval } from './eval.js';

const qMock = vi.mocked(q);

function writeTool() {
  return {
    id: 'tool-1', project_id: 'p1', name: 'createWidget', version: 1, status: 'approved',
    credential_mode: 'none',
    input_schema: JSON.stringify({
      type: 'object',
      properties: { name: { type: 'string', examples: ['Blue widget'] } },
      required: ['name'],
    }),
    upstream: JSON.stringify({
      method: 'POST', path_template: '/widgets', base_url: 'https://api.test',
      param_bindings: [{ arg: 'name', location: 'body', target: 'name' }],
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('runEval probes for write tools (BE-16)', () => {
  it('probes with the tool method and the assembled JSON body', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: any) => ({
      status: 200, text: async () => JSON.stringify({ ok: true }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    qMock
      .mockResolvedValueOnce([writeTool()])
      .mockResolvedValueOnce([
        { suite: 'contract', passed: true }, { suite: 'contract', passed: true },
        { suite: 'behavior', passed: true }, { suite: 'recovery', passed: true },
      ]);

    await runEval('p1');

    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(4);
    // Every probe uses the tool's method — never the GET default.
    for (const call of fetchMock.mock.calls) {
      expect(call[1].method).toBe('POST');
    }
    // The happy-path probe carries the sampled required body field as JSON.
    const happy = fetchMock.mock.calls[0];
    expect(happy[0]).toBe('https://api.test/widgets');
    expect(happy[1].headers['content-type']).toBe('application/json');
    expect(JSON.parse(happy[1].body)).toEqual({ name: 'Blue widget' });
  });
});
