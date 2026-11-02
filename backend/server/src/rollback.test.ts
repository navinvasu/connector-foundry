// RL-06: release rollback (deprecate) + data-plane refusal of deprecated releases.
import { describe, it, expect, vi, beforeEach } from 'vitest';

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
import { rollbackRelease } from './release.js';
import { invoke } from './runtime.js';

const oneMock = vi.mocked(one);
const withTxMock = vi.mocked(withTx);

const approved = (over: Record<string, unknown> = {}) => ({
  id: 'r2', project_id: 'p1', version: '2.0.0', status: 'approved', ...over,
});

/** Runs the tx callback with a capture-able query mock. */
function mockTx(rowCount = 1) {
  const query = vi.fn().mockResolvedValue({ rowCount });
  withTxMock.mockImplementationOnce(async (fn: any) => fn({ query }));
  return query;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('rollbackRelease', () => {
  it('deprecates an approved release, audits, and returns the previous approved fallback', async () => {
    oneMock
      .mockResolvedValueOnce(approved())                       // the release
      .mockResolvedValueOnce({ id: 'r1', version: '1.0.0' });  // previous approved
    const query = mockTx();

    const res = await rollbackRelease('r2', 'owner@example.com', 'broken schema');

    expect(res).toEqual({
      release_id: 'r2',
      version: '2.0.0',
      deprecated: true,
      fallback: { release_id: 'r1', version: '1.0.0' },
    });
    const [updateSql, updateParams] = query.mock.calls[0]!;
    expect(String(updateSql)).toContain("SET status = 'deprecated'");
    expect(String(updateSql)).toContain("WHERE id = $1 AND status = 'approved'");
    expect(updateParams).toEqual(['r2', 'owner@example.com', 'broken schema']);
    const [auditSql, auditParams] = query.mock.calls[1]!;
    expect(String(auditSql)).toContain('release.deprecated');
    const meta = JSON.parse(String(auditParams![3]));
    expect(meta).toMatchObject({ version: '2.0.0', actor: 'owner@example.com', fallback_version: '1.0.0' });
  });

  it('returns a null fallback when no previous approved release exists', async () => {
    oneMock.mockResolvedValueOnce(approved()).mockResolvedValueOnce(null);
    mockTx();
    const res = await rollbackRelease('r2', 'owner@example.com');
    expect(res.fallback).toBeNull();
  });

  it('404s on an unknown release id', async () => {
    oneMock.mockResolvedValueOnce(null);
    await expect(rollbackRelease('nope', 'a@b.c')).rejects.toMatchObject({ status: 404, code: 'release_not_found' });
    expect(withTxMock).not.toHaveBeenCalled();
  });

  it('409s when the release is already deprecated', async () => {
    oneMock.mockResolvedValueOnce(approved({ status: 'deprecated' }));
    await expect(rollbackRelease('r2', 'a@b.c')).rejects.toMatchObject({ status: 409, code: 'release_already_deprecated' });
    expect(withTxMock).not.toHaveBeenCalled();
  });

  it('409s when the release was never approved (draft)', async () => {
    oneMock.mockResolvedValueOnce(approved({ status: 'draft' }));
    await expect(rollbackRelease('r2', 'a@b.c')).rejects.toMatchObject({ status: 409, code: 'release_not_rollbackable' });
    expect(withTxMock).not.toHaveBeenCalled();
  });

  it('409s when a concurrent rollback wins the race', async () => {
    oneMock
      .mockResolvedValueOnce(approved())
      .mockResolvedValueOnce({ id: 'r1', version: '1.0.0' });
    mockTx(0); // UPDATE touched nothing — someone else deprecated it first
    await expect(rollbackRelease('r2', 'a@b.c')).rejects.toMatchObject({ status: 409, code: 'release_rollback_race' });
  });
});

describe('invoke refuses deprecated releases (RL-06)', () => {
  const req = { project_id: 'p1', version: '2.0.0', tool_name: 'getInvoices', args: {} };

  it('returns RELEASE_DEPRECATED naming the fallback version', async () => {
    oneMock
      .mockResolvedValueOnce({ ...approved({ status: 'deprecated' }), deprecate_reason: 'broken schema' })
      .mockResolvedValueOnce({ version: '1.0.0' });
    const res = await invoke(req as any);
    expect(res.ok).toBe(false);
    expect(res.error).toMatchObject({ condition: 'RELEASE_DEPRECATED' });
    expect(res.error!.message).toContain('deprecated');
    expect(res.error!.message).toContain('broken schema');
    expect(res.error!.message).toContain('1.0.0');
  });

  it('says so plainly when no approved release remains', async () => {
    oneMock
      .mockResolvedValueOnce({ ...approved({ status: 'deprecated' }), deprecate_reason: null })
      .mockResolvedValueOnce(null);
    const res = await invoke(req as any);
    expect(res.error).toMatchObject({ condition: 'RELEASE_DEPRECATED' });
    expect(res.error!.message).toContain('No approved release remains');
  });
});
