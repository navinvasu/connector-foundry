import { useEffect, useRef, useState } from 'react';
import { listJobs, type Job, type JobKind } from './api';
import { logAction } from '../shared/lib/diagnostics';

// Shared queue visibility: a job started anywhere (this screen, another
// screen, another tab) must show its running status on the dashboard AND on
// its own feature screen. The dashboard polls listJobs itself; feature
// screens use useQueueJobs for the kinds they care about.

/** A job the queue hasn't finished with yet. */
export function isJobActive(j: Job): boolean {
  return j.status === 'queued' || j.status === 'running';
}

/** Active jobs of the given kinds, newest first (listJobs already sorts). */
export function activeQueueJobs(jobs: Job[], kinds: JobKind[]): Job[] {
  const want = new Set(kinds);
  return jobs.filter((j) => isJobActive(j) && want.has(j.kind));
}

const POLL_MS = 3000;
const RETRY_MS = 5000;
// After arrival the queue may look idle only because the job hasn't been
// enqueued yet (import lands, then the backend auto-enqueues the compile;
// a teammate starts a run seconds later). Keep polling briefly so a job
// that starts just after mount is still caught and shown as in-progress
// instead of leaving the screen stale.
const IDLE_GRACE_MS = 30_000;

/**
 * Live active queue jobs of the given kinds for a project. Polls while any
 * is active; calls onSettled once when the last active job finishes (so the
 * screen can refresh its stages). An idle queue is re-polled briefly after
 * mount (IDLE_GRACE_MS) in case a job starts just after arrival; after that
 * there is no polling while idle.
 */
export function useQueueJobs(
  projectId: string | null,
  kinds: JobKind[],
  onSettled?: () => void,
): Job[] {
  const [active, setActive] = useState<Job[]>([]);
  const kindsKey = kinds.slice().sort().join(',');
  const settledRef = useRef(false);
  const onSettledRef = useRef(onSettled);
  onSettledRef.current = onSettled;
  useEffect(() => {
    if (!projectId) {
      setActive([]);
      return;
    }
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const start = Date.now();
    const poll = async () => {
      try {
        const { jobs } = await listJobs(projectId, 5);
        if (!live) return;
        const now = activeQueueJobs(jobs, kinds);
        setActive(now);
        if (now.length > 0) {
          settledRef.current = true;
          timer = setTimeout(poll, POLL_MS);
        } else if (settledRef.current) {
          settledRef.current = false;
          logAction('queue', `settled: ${kindsKey || 'jobs'}`);
          onSettledRef.current?.();
        } else if (Date.now() - start < IDLE_GRACE_MS) {
          timer = setTimeout(poll, POLL_MS);
        }
      } catch {
        if (live) timer = setTimeout(poll, RETRY_MS);
      }
    };
    void poll();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, kindsKey]);
  return active;
}
