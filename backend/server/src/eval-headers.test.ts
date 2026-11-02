// BE-17: eval probes must carry header/cookie params the way invoke will
// send them — a tool whose required tenant header is silently dropped
// would 4xx every scenario and could never honestly pass, and the same
// credential-wins precedence (EV-01's shared injection path) applies.
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

function headerTool() {
  return {
    id: 'tool-1', project_id: 'p1', name: 'getWidget', version: 1, status: 'approved',
    credential_mode: 'none',
    input_schema: JSON.stringify({
      type: 'object',
      properties: { tenant: { type: 'string' }, session: { type: 'string' } },
      required: ['tenant', 'session'],
    }),
    upstream: JSON.stringify({
      method: 'GET', path_template: '/widgets', base_url: 'https://api.test',
      param_bindings: [
        { arg: 'tenant', location: 'header', target: 'X-Tenant' },
        { arg: 'session', location: 'cookie', target: 'session' },
      ],
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('runEval probes for header/cookie tools (BE-17)', () => {
  it('sends header params and the merged Cookie header on every probe', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: any) => ({
      status: 200, text: async () => JSON.stringify({ ok: true }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    qMock
      .mockResolvedValueOnce([headerTool()])
      .mockResolvedValueOnce([
        { suite: 'contract', passed: true }, { suite: 'contract', passed: true },
        { suite: 'behavior', passed: true }, { suite: 'recovery', passed: true },
      ]);

    await runEval('p1');

    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(4);
    let sampled = 0;
    let omitted = 0;
    for (const call of fetchMock.mock.calls) {
      const tenant = call[1].headers['X-Tenant'];
      // The deliberate missing-params probe sends no args at all — it is
      // the one call where the header/cookie are absent by design.
      if (tenant === undefined) { omitted += 1; continue; }
      if (tenant === 'test') sampled += 1;
      // Sampled cookie value rides as one Cookie header pair.
      expect(call[1].headers.Cookie).toContain('session=test');
    }
    // Every arg-carrying probe transmits the header params: happy +
    // behavior carry the sampled tenant, recovery carries its corrupted
    // first arg ('__invalid__'); only missing-params omits them.
    expect(sampled).toBe(2);
    expect(omitted).toBe(1);
    // Recorded evidence URLs never carry headers — nothing to leak.
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.test/widgets');
  });
});
