// Background job queue for long-running pipeline stages (compile, eval).
//
// Design notes:
// - DB-backed (PostgreSQL), no Redis: one less service to operate, and jobs
//   survive restarts. A single worker loop runs inside the server process.
// - Claiming uses SELECT ... FOR UPDATE SKIP LOCKED so multiple server
//   processes can share the queue without double-running a job.
// - Enqueue is idempotent per (project, kind): asking twice while a job is
//   queued/running returns the existing job instead of double-processing.

import { one, q, exec, jb, uid } from './db.js';
import { compileProject } from './pipeline.js';
import { runEval, getRun } from './eval.js';
import { runDriftCheck } from './drift.js';
import { logger } from './logger.js';
import { DEFAULT_LIMIT, keysetClause, type Cursor } from './paginate.js';
import { redactString } from './redact.js';

export type JobKind = 'compile' | 'eval' | 'drift';
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface Job {
  id: string;
  project_id: string;
  kind: JobKind;
  status: JobStatus;
  payload: any;
  progress: { done: number; total: number; note: string } | null;
  result: any;
  error: string | null;
  attempts: number;
  created_by: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

const WORKER_ID = `worker-${process.pid}`;
const STUCK_AFTER_MS = 10 * 60 * 1000; // requeue jobs stuck 'running' longer than this

export async function enqueueJob(
  kind: JobKind,
  projectId: string,
  createdBy?: string | null,
  // Scoped work (e.g. evaluate/release only these tools). Dedupe matches the
  // scope too: a scoped request is different work from an unscoped one.
  payload?: Record<string, unknown>,
): Promise<{ job: Job; deduplicated: boolean }> {
  const scope = payload ?? {};
  const existing = (await one(
    `SELECT * FROM jobs WHERE project_id = $1 AND kind = $2 AND status IN ('queued', 'running')
     AND payload = $3::jsonb
     ORDER BY created_at DESC LIMIT 1`,
    [projectId, kind, JSON.stringify(scope)],
  )) as Job | null;
  if (existing) return { job: existing, deduplicated: true };

  const job = (await one(
    `INSERT INTO jobs (id, project_id, kind, created_by, payload) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [uid(), projectId, kind, createdBy ?? null, JSON.stringify(scope)],
  )) as Job;
  // Nudge the worker so the job starts promptly instead of waiting for the poll.
  void tick().catch((e) => logger.error({ msg: 'queue tick failed', error: e instanceof Error ? e.message : String(e) }));
  return { job, deduplicated: false };
}

export async function getJob(id: string): Promise<Job | null> {
  return (await one(`SELECT * FROM jobs WHERE id = $1`, [id])) as Job | null;
}

// Recent jobs for a project, newest first. Returns limit+1 rows so the
// route can detect a following page (BE-08 keyset pagination).
export async function listJobs(
  projectId: string,
  limit = DEFAULT_LIMIT,
  cursor: Cursor | null = null,
): Promise<Job[]> {
  const { clause, params } = keysetClause({
    cursor, direction: 'DESC', keyCol: 'created_at', idCol: 'id', paramStart: 2,
  });
  return (await q(
    `SELECT * FROM jobs WHERE project_id = $1${clause} ORDER BY created_at DESC, id DESC LIMIT $${params.length + 2}`,
    [projectId, ...params, limit + 1],
  )) as Job[];
}

async function setProgress(jobId: string, done: number, total: number, note: string) {
  await exec(`UPDATE jobs SET progress = $2 WHERE id = $1`, [jobId, jb({ done, total, note })]);
}

/** Mark finished rows for a completed job. */
async function finish(jobId: string, status: 'succeeded' | 'failed', result?: unknown, error?: string) {
  await exec(
    `UPDATE jobs SET status = $2, result = $3, error = $4, finished_at = now() WHERE id = $1`,
    // DP-05: a stored job error is a log surface — redact before persisting.
    [jobId, status, result === undefined ? null : jb(result), error ? redactString(error) : null],
  );
}

const handlers: Record<JobKind, (job: Job) => Promise<unknown>> = {
  compile: async (job) => {
    const { tools_created } = await compileProject(job.project_id, (done, total, note) =>
      setProgress(job.id, done, total, note),
    );
    return { tools_created };
  },
  eval: async (job) => {
    // Scoped runs carry {tool_ids} in the job payload (POST /:id/eval).
    const payload = (typeof job.payload === 'string' ? JSON.parse(job.payload) : job.payload ?? {}) as {
      tool_ids?: string[];
    };
    const runId = await runEval(job.project_id, `queue:${job.id}`, (done, total, note) =>
      setProgress(job.id, done, total, note),
      payload.tool_ids ? { toolIds: payload.tool_ids } : undefined,
    );
    const { run } = await getRun(runId);
    return { run_id: runId, status: (run as any)?.status };
  },
  // TE-03: scheduled drift check against the prod release's frozen tools.
  // Manual triggers pass the user as created_by; the sweeper passes null.
  drift: async (job) => {
    const checkId = await runDriftCheck(
      job.project_id,
      job.created_by ? 'manual' : 'schedule',
      (done, total, note) => setProgress(job.id, done, total, note),
    );
    return { drift_check_id: checkId };
  },
};

async function claim(): Promise<Job | null> {
  return (await one(
    `UPDATE jobs
        SET status = 'running', started_at = now(), attempts = attempts + 1,
            locked_by = $1, locked_at = now()
      WHERE id = (
        SELECT id FROM jobs WHERE status = 'queued' ORDER BY created_at LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING *`,
    [WORKER_ID],
  )) as Job | null;
}

async function runJob(job: Job) {
  const startNote =
    job.kind === 'compile' ? 'Compiling tools…'
    : job.kind === 'drift' ? 'Checking for drift…'
    : 'Starting evaluation…';
  await setProgress(job.id, 0, 1, startNote);
  try {
    const result = await handlers[job.kind](job);
    await finish(job.id, 'succeeded', result);
  } catch (e) {
    await finish(job.id, 'failed', undefined, e instanceof Error ? e.message : String(e));
  }
}

let ticking = false;
/** Claim and run queued jobs until the queue is empty. Exported for tests. */
export async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    for (;;) {
      const job = await claim();
      if (!job) break;
      await runJob(job);
    }
  } finally {
    ticking = false;
  }
}

/** Requeue jobs left 'running' by a dead worker, then start the poll loop. */
export function startWorker(pollMs = 2000) {
  void (async () => {
    const r = await exec(
      `UPDATE jobs SET status = 'queued', locked_by = NULL, locked_at = NULL, started_at = NULL
       WHERE status = 'running' AND locked_at < now() - make_interval(secs => $1)`,
      [STUCK_AFTER_MS / 1000],
    );
    if (r > 0) logger.info({ msg: 'requeued stuck jobs', count: r });
  })().catch((e) => logger.error({ msg: 'requeue failed', error: e instanceof Error ? e.message : String(e) }));
  setInterval(() => {
    void tick().catch((e) => logger.error({ msg: 'queue tick failed', error: e instanceof Error ? e.message : String(e) }));
  }, pollMs);
  void tick().catch((e) => logger.error({ msg: 'queue tick failed', error: e instanceof Error ? e.message : String(e) }));
}
