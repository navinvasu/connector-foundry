import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./db.js', () => ({
  one: vi.fn(),
  q: vi.fn(),
  exec: vi.fn(),
  jb: (v: unknown) => JSON.stringify(v),
  uid: () => 'job-1',
}));

vi.mock('./pipeline.js', () => ({
  compileProject: vi.fn(),
}));

vi.mock('./eval.js', () => ({
  runEval: vi.fn(),
  getRun: vi.fn(),
}));

import { one, q, exec } from './db.js';
import { compileProject } from './pipeline.js';
import { runEval, getRun } from './eval.js';
import { enqueueJob, getJob, listJobs, tick } from './queue.js';

const oneMock = vi.mocked(one);
const qMock = vi.mocked(q);
const execMock = vi.mocked(exec);
const compileMock = vi.mocked(compileProject);
const runEvalMock = vi.mocked(runEval);
const getRunMock = vi.mocked(getRun);

const queuedJob = (kind: 'compile' | 'eval' = 'compile') => ({
  id: 'job-9', project_id: 'p1', kind, status: 'queued',
  payload: null, progress: null, result: null, error: null, attempts: 0,
  created_at: new Date().toISOString(), started_at: null, finished_at: null,
});

beforeEach(() => {
  vi.clearAllMocks();
  oneMock.mockResolvedValue(null); // default: nothing to claim / no dup
});

function finishCalls() {
  return execMock.mock.calls.filter((c) => String(c[0]).includes('SET status')) as Array<[string, unknown[]]>;
}

describe('enqueueJob', () => {
  it('returns the in-flight job instead of double-enqueueing', async () => {
    const existing = queuedJob();
    oneMock.mockResolvedValueOnce(existing);
    const { job, deduplicated } = await enqueueJob('compile', 'p1', 'user-1');
    expect(deduplicated).toBe(true);
    expect(job).toBe(existing);
    // No INSERT issued.
    expect(execMock).not.toHaveBeenCalled();
  });

  it('inserts a new job when none is active', async () => {
    const created = { ...queuedJob(), id: 'job-1' };
    oneMock.mockResolvedValueOnce(null).mockResolvedValueOnce(created);
    const { job, deduplicated } = await enqueueJob('eval', 'p1', 'user-1');
    expect(deduplicated).toBe(false);
    expect(job.id).toBe('job-1');
    const insert = oneMock.mock.calls[1]!;
    expect(String(insert[0])).toMatch(/INSERT INTO jobs/);
    expect(insert[1]!).toEqual(['job-1', 'p1', 'eval', 'user-1']);
  });
});

describe('getJob / listJobs', () => {
  it('getJob returns the row', async () => {
    const expected = queuedJob();
    oneMock.mockResolvedValue(expected);
    expect(await getJob('job-9')).toBe(expected);
  });

  it('listJobs orders newest-first with a limit and stable keyset', async () => {
    qMock.mockResolvedValue([queuedJob()]);
    const jobs = await listJobs('p1', 5);
    expect(jobs).toHaveLength(1);
    const [sql, params] = qMock.mock.calls[0]!;
    expect(String(sql)).toContain('ORDER BY created_at DESC, id DESC');
    expect(params).toEqual(['p1', 6]); // limit + 1 probe row for has_more
  });

  it('listJobs applies a cursor filter', async () => {
    qMock.mockResolvedValue([]);
    await listJobs('p1', 5, { t: '2026-09-28T00:00:00.000Z', i: 'job-9' });
    const [sql, params] = qMock.mock.calls[0]!;
    expect(String(sql)).toContain('(created_at, id) < ($2, $3)');
    expect(params).toEqual(['p1', '2026-09-28T00:00:00.000Z', 'job-9', 6]);
  });
});

describe('tick (worker)', () => {
  it('runs a queued compile job to success with progress updates', async () => {
    oneMock.mockResolvedValueOnce(queuedJob('compile')).mockResolvedValue(null);
    compileMock.mockResolvedValue({ tools_created: 3, tool_ids: ['t1', 't2', 't3'] });

    await tick();

    expect(compileMock).toHaveBeenCalledTimes(1);
    // Progress was reported…
    const progress = execMock.mock.calls.filter((c) => String(c[0]).includes('SET progress'));
    expect(progress.length).toBeGreaterThan(0);
    // …and the job finished successfully with the handler result.
    const finished = finishCalls();
    expect(finished).toHaveLength(1);
    expect(finished[0]![1][1]).toBe('succeeded');
    expect(JSON.parse(finished[0]![1][2] as string)).toEqual({ tools_created: 3 });
  });

  it('marks the job failed and records the error when the handler throws', async () => {
    oneMock.mockResolvedValueOnce(queuedJob('compile')).mockResolvedValue(null);
    compileMock.mockRejectedValue(new Error('No imported operations to compile'));

    await tick();

    const finished = finishCalls();
    expect(finished).toHaveLength(1);
    expect(finished[0]![1][1]).toBe('failed');
    expect(finished[0]![1][3]).toBe('No imported operations to compile');
  });

  it('runs eval jobs and records the run outcome', async () => {
    oneMock.mockResolvedValueOnce(queuedJob('eval')).mockResolvedValue(null);
    runEvalMock.mockResolvedValue('run-1');
    getRunMock.mockResolvedValue({ run: { status: 'failed' }, results: [] } as any);

    await tick();

    expect(runEvalMock).toHaveBeenCalledTimes(1);
    const finished = finishCalls();
    expect(finished[0]![1][1]).toBe('succeeded');
    expect(JSON.parse(finished[0]![1][2] as string)).toEqual({ run_id: 'run-1', status: 'failed' });
  });

  it('exits quietly when the queue is empty', async () => {
    await tick();
    expect(compileMock).not.toHaveBeenCalled();
    expect(runEvalMock).not.toHaveBeenCalled();
    expect(execMock).not.toHaveBeenCalled();
  });

  it('drains multiple queued jobs in one tick', async () => {
    oneMock
      .mockResolvedValueOnce(queuedJob('compile'))
      .mockResolvedValueOnce(queuedJob('eval'))
      .mockResolvedValue(null);
    compileMock.mockResolvedValue({ tools_created: 1, tool_ids: ['t1'] });
    runEvalMock.mockResolvedValue('run-2');
    getRunMock.mockResolvedValue({ run: { status: 'passed' }, results: [] } as any);

    await tick();

    expect(compileMock).toHaveBeenCalledTimes(1);
    expect(runEvalMock).toHaveBeenCalledTimes(1);
    expect(finishCalls()).toHaveLength(2);
  });
});
