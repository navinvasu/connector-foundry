// RL-07: release channels — promotion lifecycle + channel-alias invoke.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';

vi.mock('./db.js', () => ({
  one: vi.fn(),
  q: vi.fn(),
  exec: vi.fn(),
  withTx: vi.fn(),
  jb: (v: unknown) => JSON.stringify(v),
  uid: () => 'test-uid',
  J: { parse: (v: any, fb: any) => (v == null ? fb : v) },
  audit: vi.fn(),
}));

import { one, withTx } from './db.js';
import {
  isChannelAlias, normalizeChannel, createRelease, promoteRelease, promotionReadiness, resolveChannelRelease,
} from './release.js';
import { invoke, resetUpstreamBreakers } from './runtime.js';

const oneMock = vi.mocked(one);
const withTxMock = vi.mocked(withTx);

function mockTx(rowCount = 1) {
  const query = vi.fn().mockResolvedValue({ rowCount });
  withTxMock.mockImplementationOnce(async (fn: any) => fn({ query }));
  return query;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetUpstreamBreakers();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('channel helpers', () => {
  it('recognizes exactly the two channel aliases', () => {
    expect(isChannelAlias('staging')).toBe(true);
    expect(isChannelAlias('prod')).toBe(true);
    expect(isChannelAlias('1.0.0')).toBe(false);
    expect(isChannelAlias('Prod')).toBe(false);
    expect(normalizeChannel('prod')).toBe('prod');
    expect(normalizeChannel('production')).toBeNull();
    expect(normalizeChannel(42)).toBeNull();
  });

  it('reserves alias names as release versions', async () => {
    const err = await createRelease('p1', 'prod').catch((e) => e);
    expect(err).toMatchObject({ status: 400, code: 'release_version_reserved' });
    expect(oneMock).not.toHaveBeenCalled();
  });
});

describe('promoteRelease', () => {
  const approved = (over: Record<string, unknown> = {}) => ({
    id: 'r2', project_id: 'p1', version: '2.0.0', status: 'approved', channel: 'staging', ...over,
  });
  // RL-08: prod promotion reads the latest completed eval run; a stored
  // certified verdict (EV-05) is the happy path these tests exercise.
  const certifiedRun = (over: Record<string, unknown> = {}) => ({
    id: 'run-1', project_id: 'p1', status: 'passed',
    summary: {
      certification: {
        certified: true, criteria_version: 'v1',
        checks: [{ id: 'run_passed', label: 'Evaluation run passed', status: 'pass', detail: 'ok' }],
      },
    },
    ...over,
  });

  it('moves staging → prod in one transaction with an audit row', async () => {
    oneMock.mockResolvedValueOnce(approved());
    oneMock.mockResolvedValueOnce(certifiedRun());
    const query = mockTx();

    const res = await promoteRelease('r2', 'owner@example.com');

    expect(res).toEqual({ release_id: 'r2', version: '2.0.0', channel: 'prod', promoted: true });
    const [updateSql, updateParams] = query.mock.calls[0]!;
    expect(String(updateSql)).toContain('SET channel = $2');
    expect(String(updateSql)).toContain("status = 'approved'");
    expect(updateParams).toEqual(['r2', 'prod', 'owner@example.com']);
    const [auditSql, auditParams] = query.mock.calls[1]!;
    expect(String(auditSql)).toContain('release.promoted');
    expect(JSON.parse(String(auditParams![3]))).toMatchObject({
      version: '2.0.0', from_channel: 'staging', to_channel: 'prod',
    });
  });

  it('is an idempotent no-op when already in the target channel', async () => {
    oneMock.mockResolvedValueOnce(approved({ channel: 'prod' }));
    const res = await promoteRelease('r2', 'owner@example.com', 'prod');
    expect(res).toEqual({ release_id: 'r2', version: '2.0.0', channel: 'prod', promoted: false });
    expect(withTxMock).not.toHaveBeenCalled();
  });

  it('404s on an unknown release', async () => {
    oneMock.mockResolvedValueOnce(null);
    await expect(promoteRelease('nope', 'a@b.c')).rejects.toMatchObject({ status: 404, code: 'release_not_found' });
  });

  it('409s for a draft (approve first) and for a deprecated release', async () => {
    oneMock.mockResolvedValueOnce(approved({ status: 'draft' }));
    await expect(promoteRelease('r2', 'a@b.c')).rejects.toMatchObject({ status: 409, code: 'release_not_promotable' });
    oneMock.mockResolvedValueOnce(approved({ status: 'deprecated', channel: 'prod' }));
    await expect(promoteRelease('r2', 'a@b.c', 'staging')).rejects.toMatchObject({ status: 409, code: 'release_deprecated' });
    expect(withTxMock).not.toHaveBeenCalled();
  });

  it('409s when a concurrent promotion wins the race', async () => {
    oneMock.mockResolvedValueOnce(approved());
    oneMock.mockResolvedValueOnce(certifiedRun());
    mockTx(0);
    await expect(promoteRelease('r2', 'a@b.c')).rejects.toMatchObject({ status: 409, code: 'release_promote_race' });
  });

  it('blocks prod promotion (422) when no completed eval run exists', async () => {
    oneMock.mockResolvedValueOnce(approved());
    oneMock.mockResolvedValueOnce(null); // no completed run
    await expect(promoteRelease('r2', 'a@b.c')).rejects.toMatchObject({ status: 422, code: 'promotion_blocked' });
    expect(withTxMock).not.toHaveBeenCalled();
  });

  it('blocks prod promotion (422) when the latest run is not certified, naming what is missing', async () => {
    oneMock.mockResolvedValueOnce(approved());
    oneMock.mockResolvedValueOnce(certifiedRun({
      summary: {
        certification: {
          certified: false, criteria_version: 'v1',
          checks: [{ id: 'safety_read_only', label: 'Read-only safety', status: 'fail', detail: 'Write tools present.' }],
        },
      },
    }));
    const err = await promoteRelease('r2', 'a@b.c').catch((e) => e);
    expect(err).toMatchObject({ status: 422, code: 'promotion_blocked' });
    expect(err.message).toContain('Read-only safety');
    expect(withTxMock).not.toHaveBeenCalled();
  });

  it('promotionReadiness lists each missing item with its fix', async () => {
    oneMock.mockResolvedValueOnce(approved());
    oneMock.mockResolvedValueOnce(null); // no completed run
    const readiness = await promotionReadiness('r2');
    expect(readiness.ready).toBe(false);
    expect(readiness.certified).toBe(false);
    expect(readiness.checks[0]).toMatchObject({ id: 'release_approved', status: 'pass' });
    const missing = readiness.checks.find((c) => c.id === 'eval_run_present');
    expect(missing?.status).toBe('fail');
    expect(missing?.action).toMatch(/Run an evaluation/);
  });
});

describe('resolveChannelRelease', () => {
  it('returns the newest approved release in the channel, or null', async () => {
    oneMock.mockResolvedValueOnce({ id: 'r2', version: '2.0.0' });
    await expect(resolveChannelRelease('p1', 'staging')).resolves.toEqual({ id: 'r2', version: '2.0.0' });
    const [sql, params] = oneMock.mock.calls[0]!;
    expect(String(sql)).toContain("status = 'approved'");
    expect(params).toEqual(['p1', 'staging']);
    oneMock.mockResolvedValueOnce(null);
    await expect(resolveChannelRelease('p1', 'prod')).resolves.toBeNull();
  });
});

describe('invoke by channel alias (RL-07 AC)', () => {
  const VERSION = '2.0.0';
  const BUNDLE = 'bundle-xyz';
  const signature = createHmac('sha256', 'dev-only-signing-secret')
    .update(`${VERSION}:${BUNDLE}`).digest('hex');

  it('refuses an empty prod channel without falling through to staging', async () => {
    oneMock.mockResolvedValueOnce(null); // channel resolution finds nothing
    const res = await invoke({ project_id: 'p1', version: 'prod', tool_name: 'getThing', args: {} });
    expect(res.ok).toBe(false);
    expect(res.error).toMatchObject({ condition: 'RELEASE_CHANNEL_EMPTY' });
    expect(res.error!.message).toContain('promoted to prod');
    expect(res.release_version).toBe('prod');
  });

  it('serves the staged release by alias and reports the real version', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: any): Promise<any> => ({
      status: 200, text: async () => '{"temp":21}',
    }));
    vi.stubGlobal('fetch', fetchMock);
    oneMock
      .mockResolvedValueOnce({ id: 'r2', version: VERSION }) // channel resolution
      .mockResolvedValueOnce({ // the release row itself
        id: 'r2', project_id: 'p1', version: VERSION, status: 'approved',
        bundle_hash: BUNDLE, signature,
      })
      .mockResolvedValueOnce({ // frozen tool snapshot
        tool_snapshot: {
          name: 'getThing', credential_mode: 'none', recovery_rules: [],
          upstream: { base_url: 'https://api.example.com', path_template: '/thing', method: 'GET' },
        },
      });

    const res = await invoke({ project_id: 'p1', version: 'staging', tool_name: 'getThing', args: {} });

    expect(res.ok).toBe(true);
    expect(res.release_version).toBe(VERSION);
    expect(res.result).toEqual({ temp: 21 });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
