import { describe, expect, it } from 'vitest';
import { activeQueueJobs, isJobActive } from './queueJobs';
import type { Job } from './api';

const job = (over: Partial<Job> = {}): Job => ({
  id: 'j1', project_id: 'p1', kind: 'eval', status: 'running',
  progress: null, result: null, error: null, created_at: '2026-10-26T00:00:00Z',
  started_at: null, finished_at: null, ...over,
});

describe('queue job visibility', () => {
  it('treats queued and running as active, terminal states as idle', () => {
    expect(isJobActive(job({ status: 'queued' }))).toBe(true);
    expect(isJobActive(job({ status: 'running' }))).toBe(true);
    for (const status of ['succeeded', 'failed', 'cancelled'] as const) {
      expect(isJobActive(job({ status }))).toBe(false);
    }
  });

  it('keeps only active jobs of the requested kinds', () => {
    const jobs = [
      job({ id: 'e1', kind: 'eval', status: 'running' }),
      job({ id: 'c1', kind: 'compile', status: 'queued' }),
      job({ id: 'e2', kind: 'eval', status: 'succeeded' }),
    ];
    expect(activeQueueJobs(jobs, ['eval']).map((j) => j.id)).toEqual(['e1']);
    expect(activeQueueJobs(jobs, ['eval', 'compile']).map((j) => j.id)).toEqual(['e1', 'c1']);
    expect(activeQueueJobs(jobs, ['compile']).map((j) => j.id)).toEqual(['c1']);
  });
});
