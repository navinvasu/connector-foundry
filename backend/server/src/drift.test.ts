// TE-03: drift detection — scheduled contract probes against the prod
// release's frozen tools, alert open/update/resolve lifecycle, sweeper.
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
  audit: vi.fn(),
}));

import { one, q, exec, audit } from './db.js';
import { runDriftCheck, sweepDriftChecks } from './drift.js';

const oneMock = vi.mocked(one);
const qMock = vi.mocked(q);
const execMock = vi.mocked(exec);
const auditMock = vi.mocked(audit);

const prodRelease = { id: 'rel-1', version: '1.0.0' };

function frozenTool(over: any = {}) {
  return {
    tool_id: 'tool-1',
    snapshot: {
      name: 'getForecast',
      input_schema: {
        type: 'object',
        properties: { latitude: { type: 'number' } },
        required: ['latitude'],
      },
      upstream: {
        method: 'GET',
        path_template: '/forecast',
        base_url: 'https://api.test',
        param_bindings: [{ arg: 'latitude', location: 'query', target: 'latitude' }],
      },
      effect_classes: ['read_only'],
      credential_mode: 'none',
      ...over,
    },
  };
}

function okFetch(status = 200, body: unknown = { forecast: 'sunny' }) {
  return vi.fn(async () => ({ status, text: async () => JSON.stringify(body) }));
}

/** one() answers: release resolution, then per-tool open-alert lookups. */
function mockReleaseAndAlerts(release: any, openAlert: any = null) {
  oneMock.mockImplementation(async (sql: string) => {
    if (String(sql).includes('FROM releases')) return release;
    if (String(sql).includes('FROM drift_alerts')) return openAlert;
    return null;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Params array of the first exec call whose SQL contains `fragment`. */
function execParams(fragment: string): unknown[] {
  const call = execMock.mock.calls.find((c) => String(c[0]).includes(fragment));
  expect(call).toBeDefined();
  return (call as unknown[])[1] as unknown[];
}

describe('runDriftCheck', () => {
  it('records a clean check with no alerts when the contract holds', async () => {
    vi.stubGlobal('fetch', okFetch());
    mockReleaseAndAlerts(prodRelease);
    qMock.mockResolvedValue([frozenTool()]);

    const checkId = await runDriftCheck('p1', 'schedule');

    expect(checkId).toMatch(/^uid-/);
    // Check row opened…
    expect(execMock.mock.calls[0][0]).toContain('INSERT INTO drift_checks');
    // …no alert opened…
    expect(execMock.mock.calls.some((c) => String(c[0]).includes('INSERT INTO drift_alerts'))).toBe(false);
    expect(auditMock).not.toHaveBeenCalled();
    // …and the summary records a pass.
    const summary = JSON.parse(execParams("SET status = 'succeeded'")[1] as string);
    expect(summary.release_version).toBe('1.0.0');
    expect(summary.tools_passed).toBe(1);
    expect(summary.tools_failed).toEqual([]);
  });

  it('opens an alert and audits drift.detected when the contract breaks', async () => {
    vi.stubGlobal('fetch', okFetch(500, { error: 'boom' }));
    mockReleaseAndAlerts(prodRelease);
    qMock.mockResolvedValue([frozenTool()]);

    await runDriftCheck('p1', 'schedule');

    const insert = execMock.mock.calls.find((c) => String(c[0]).includes('INSERT INTO drift_alerts'))!;
    expect(insert).toBeDefined();
    const evidence = JSON.parse(execParams('INSERT INTO drift_alerts')[5] as string);
    expect(evidence.failed_scenarios).toEqual(['happy_path_2xx_json', 'missing_params_handled']);
    expect(auditMock).toHaveBeenCalledWith('p1', 'drift.detected', 'drift_alert', expect.any(String),
      expect.objectContaining({ tool_name: 'getForecast', failed_scenarios: evidence.failed_scenarios }));
  });

  it('updates (not duplicates) the open alert on repeat failures, and resolves it when the contract heals', async () => {
    const openAlert = { id: 'alert-1' };

    // Still failing: the open alert is refreshed, not re-inserted.
    vi.stubGlobal('fetch', okFetch(500, { error: 'boom' }));
    mockReleaseAndAlerts(prodRelease, openAlert);
    qMock.mockResolvedValue([frozenTool()]);
    await runDriftCheck('p1', 'schedule');
    expect(execMock.mock.calls.some((c) => String(c[0]).includes('INSERT INTO drift_alerts'))).toBe(false);
    const refresh = execMock.mock.calls.find((c) => String(c[0]).includes('SET last_seen_at = now()'))!;
    expect(refresh).toBeDefined();
    expect(auditMock).not.toHaveBeenCalledWith('p1', 'drift.detected', expect.anything(), expect.anything(), expect.anything());

    // Now passing: the alert resolves with an audit row.
    vi.clearAllMocks();
    vi.stubGlobal('fetch', okFetch());
    mockReleaseAndAlerts(prodRelease, openAlert);
    qMock.mockResolvedValue([frozenTool()]);
    await runDriftCheck('p1', 'schedule');
    const resolve = execMock.mock.calls.find((c) => String(c[0]).includes("SET status = 'resolved'"))!;
    expect(resolve).toBeDefined();
    expect(auditMock).toHaveBeenCalledWith('p1', 'drift.resolved', 'drift_alert', 'alert-1',
      expect.objectContaining({ tool_name: 'getForecast' }));
  });

  it('skips write tools and oauth tools without probing them', async () => {
    const fetchMock = okFetch();
    vi.stubGlobal('fetch', fetchMock);
    mockReleaseAndAlerts(prodRelease);
    qMock.mockResolvedValue([
      frozenTool(),
      { ...frozenTool(), tool_id: 'tool-2', snapshot: { ...frozenTool().snapshot, name: 'createWidget', effect_classes: ['mutating'] } },
      { ...frozenTool(), tool_id: 'tool-3', snapshot: { ...frozenTool().snapshot, name: 'getPrivate', credential_mode: 'oauth' } },
    ]);

    await runDriftCheck('p1', 'schedule');

    // Only the read-only tool was probed (2 contract scenarios = 2 fetches).
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const summary = JSON.parse(execParams("SET status = 'succeeded'")[1] as string);
    expect(summary.tools_checked).toBe(1);
    expect(summary.tools_skipped).toEqual([
      { tool_id: 'tool-2', tool_name: 'createWidget', reason: 'write_tool' },
      { tool_id: 'tool-3', tool_name: 'getPrivate', reason: 'oauth_credential' },
    ]);
    // A scheduled check never fires a mutation or a bare OAuth call.
    expect(execMock.mock.calls.some((c) => String(c[0]).includes('INSERT INTO drift_alerts'))).toBe(false);
  });

  it('records a clean no-op when there is no prod release', async () => {
    mockReleaseAndAlerts(null);
    await runDriftCheck('p1', 'manual');
    expect(qMock).not.toHaveBeenCalled();
    expect(JSON.parse(execParams("SET status = 'succeeded'")[1] as string))
      .toEqual({ status: 'no_prod_release', tools_checked: 0 });
  });

  it('never writes review items — drift checks are observation-only', async () => {
    // Lenient 200 on missing params sets the reviewItem on the outcome;
    // the drift path must not persist it.
    vi.stubGlobal('fetch', okFetch());
    mockReleaseAndAlerts(prodRelease);
    qMock.mockResolvedValue([frozenTool()]);
    await runDriftCheck('p1', 'schedule');
    expect(execMock.mock.calls.some((c) => String(c[0]).includes('INSERT INTO review_items'))).toBe(false);
  });
});

describe('sweepDriftChecks', () => {
  it('enqueues a drift job per due project and skips the rest', async () => {
    qMock.mockResolvedValue([{ id: 'p1' }]);
    oneMock
      .mockResolvedValueOnce(null) // no in-flight drift job
      .mockResolvedValueOnce({ id: 'job-1' }); // insert returning

    const n = await sweepDriftChecks();
    expect(n).toBe(1);
    const insert = oneMock.mock.calls[1][0] as string;
    expect(insert).toContain('INSERT INTO jobs');
    expect(oneMock.mock.calls[1][1]).toEqual(expect.arrayContaining(['drift', 'p1']));
  });

  it('enqueues nothing when no project is due', async () => {
    qMock.mockResolvedValue([]);
    const n = await sweepDriftChecks();
    expect(n).toBe(0);
    expect(oneMock).not.toHaveBeenCalled();
  });
});
