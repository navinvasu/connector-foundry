import type { Job } from '../../data/api';
import { Badge, ProgressBar } from './atoms';
import { cn } from '../../shared/lib/utils';

const toneFor = (status: Job['status']): 'blue' | 'amber' | 'green' | 'red' | 'purple' => {
  switch (status) {
    case 'queued': return 'blue';
    case 'running': return 'amber';
    case 'succeeded': return 'green';
    case 'failed': return 'red';
    case 'cancelled': return 'purple';
  }
};

const labelFor = (status: Job['status']): string => {
  switch (status) {
    case 'queued': return 'Queued';
    case 'running': return 'Running';
    case 'succeeded': return 'Done';
    case 'failed': return 'Failed';
    case 'cancelled': return 'Cancelled';
  }
};

/** Live status for a background queue job: state pill, progress bar, and errors. */
export default function JobProgress({ job, className }: { job: Job | null; className?: string }) {
  if (!job) return null;
  const p = job.progress;
  const pct =
    p && p.total > 0 ? Math.round((p.done / p.total) * 100) : job.status === 'running' ? 0 : 100;
  return (
    <div className={cn('card-pad', className)}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Badge tone={toneFor(job.status)}>{labelFor(job.status)}</Badge>
          <span className="text-sm text-slate-300">
            {job.kind === 'compile' ? 'Compiling tools' : 'Running evaluation'}
          </span>
        </div>
        <span className="mono text-xs text-slate-500">{pct}%</span>
      </div>
      <div className="mt-3">
        <ProgressBar value={pct} tone={job.status === 'failed' ? 'red' : 'amber'} />
      </div>
      {p?.note && <p className="mt-2 text-sm text-slate-400">{p.note}</p>}
      {job.error && (
        <p className="mt-2 text-sm text-red-400">Error: {job.error}</p>
      )}
      {job.status === 'succeeded' && job.result && (
        <p className="mt-2 text-sm text-slate-400">
          {job.kind === 'compile' && typeof job.result.tools_created === 'number'
            ? `${job.result.tools_created} tool draft${job.result.tools_created === 1 ? '' : 's'} created.`
            : job.kind === 'eval' && job.result.run_id
              ? 'Evaluation finished — results below.'
              : 'Finished.'}
        </p>
      )}
    </div>
  );
}
