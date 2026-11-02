import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Check, Cog, Search } from 'lucide-react';
import {
  enqueueCompile,
  pollJob,
  listProjectOperations,
  listProjectTools,
  type Job,
} from '../../data/api';
import { useFoundryStore, useActiveProject, useProjectAccess } from '../../app/store';
import NoProject from '../../shared/components/NoProject';
import ReadOnlyBanner from '../../shared/components/ReadOnlyBanner';
import JobProgress from '../../shared/components/JobProgress';
import { useQueueJobs } from '../../data/queueJobs';
import {
  Badge,
  EffectBadge,
  EmptyState,
  KvRow,
  MethodBadge,
  ProgressBar,
  SectionHeader,
} from '../../shared/components/atoms';
import { cn } from '../../shared/lib/utils';

type RecFilter = 'all' | 'include' | 'review' | 'exclude';
type EffectFilter = 'all' | 'READ' | 'WRITE' | 'DESTRUCTIVE';

/** Rows per page for the Findings and Operation inventory lists. */
const PAGE_SIZE = 10;

const recBadgeTone: Record<Exclude<RecFilter, 'all'>, 'green' | 'amber' | 'gray'> = {
  include: 'green',
  review: 'amber',
  exclude: 'gray',
};

function FilterButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'btn btn-sm',
        active
          ? 'bg-neon text-ink-950 font-semibold border border-neon hover:bg-orange-300'
          : 'bg-white text-slate-400 border border-white/15 hover:bg-white/5',
      )}
    >
      {children}
    </button>
  );
}

function docScoreTone(score: number): 'green' | 'amber' | 'red' {
  if (score >= 90) return 'green';
  if (score >= 70) return 'amber';
  return 'red';
}

/**
 * Live pipeline panel for a real backend project: imported operations and
 * tool compilation, driven by the background job queue.
 */
function RealImportPanel({ projectId, projectName }: { projectId: string; projectName: string }) {
  const [opCount, setOpCount] = useState<number | null>(null);
  const [toolCount, setToolCount] = useState<number | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // FE-09: compiling is a project mutation — viewers watch, not run.
  const access = useProjectAccess();
  const loadProject = useFoundryStore((s) => s.loadProject);
  // Compilation auto-starts with every import — a compile running anywhere
  // (fresh import, another tab) shows here; when it settles the counts
  // refresh. A compile started from this screen uses the local job above.
  const queueCompiles = useQueueJobs(projectId, ['compile'], () => {
    void refresh();
    void loadProject(projectId);
  });
  const queueCompile = queueCompiles[0] ?? null;
  const shownJob = job ?? queueCompile;

  const refresh = async () => {
    try {
      const [{ operations }, { tools }] = await Promise.all([
        listProjectOperations(projectId),
        listProjectTools(projectId),
      ]);
      setOpCount(operations.length);
      setToolCount(tools.length);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    setOpCount(null);
    setToolCount(null);
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const compile = async () => {
    setBusy(true);
    setError(null);
    try {
      const { job: enqueued, deduplicated } = await enqueueCompile(projectId);
      if (deduplicated) setError('A compile job is already queued or running — showing its progress.');
      const done = await pollJob(enqueued.id, setJob);
      setJob(done);
      if (done.status === 'failed') throw new Error(done.error ?? 'Compile job failed');
      await Promise.all([refresh(), loadProject(projectId)]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card-pad border-l-4 border-l-neon">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <SectionHeader
            title="Project pipeline"
            sub={`Imported contract for ${projectName}. Compilation runs on the background queue.`}
          />
          <div className="flex gap-6 mt-2">
            <div>
              <div className="text-2xl font-bold text-slate-100">{opCount ?? '…'}</div>
              <div className="text-xs text-slate-500">operations imported</div>
            </div>
            <div>
              <div className="text-2xl font-bold text-slate-100">{toolCount ?? '…'}</div>
              <div className="text-xs text-slate-500">tool drafts compiled</div>
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={() => compile().catch(() => {})}
          disabled={busy || opCount === 0 || !access.canEdit}
          className={cn(
            'btn',
            busy || opCount === 0 || !access.canEdit
              ? 'bg-white/10 text-slate-500'
              : 'bg-neon text-ink-950 font-semibold border border-neon hover:bg-orange-300',
          )}
          title={!access.canEdit ? (access.readOnlyReason ?? undefined) : opCount === 0 ? 'Import a source first' : 'Compile operations into tool drafts'}
        >
          <Cog className="h-4 w-4" />
          {busy ? 'Compiling…' : toolCount ? 'Re-compile tools' : 'Compile tools'}
        </button>
      </div>

      <div className="mt-4">
        <ReadOnlyBanner reason={access.readOnlyReason} />
      </div>

      {shownJob && <JobProgress job={shownJob} className="mt-4" />}

      {error && (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <p className="text-sm text-red-300">{error}</p>
          <button type="button" onClick={() => void refresh()} className="btn-secondary btn-sm">
            Retry
          </button>
        </div>
      )}
    </section>
  );
}

export default function ImportPage() {
  const findings = useFoundryStore((s) => s.findings);
  const resolveFinding = useFoundryStore((s) => s.resolveFinding);
  // FE-09: resolving a finding is a project mutation.
  const access = useProjectAccess();

  const [recFilter, setRecFilter] = useState<RecFilter>('all');
  const [effectFilter, setEffectFilter] = useState<EffectFilter>('all');
  const [search, setSearch] = useState('');
  // Both lists below paginate at 10 rows; page resets on filter/project change.
  const [findingPage, setFindingPage] = useState(0);
  const [opsPage, setOpsPage] = useState(0);
  useEffect(() => { setOpsPage(0); }, [recFilter, effectFilter, search]);

  const openCount = findings.filter((f) => f.status === 'open').length;
  const resolvedCount = findings.length - openCount;

  const ops = useFoundryStore((s) => s.operations);
  const activeProject = useActiveProject();

  const filtered = ops.filter((op) => {
    if (recFilter !== 'all' && op.recommendation !== recFilter) return false;
    if (effectFilter !== 'all' && op.effect !== effectFilter) return false;
    if (search) {
      const q = search.toLowerCase();
      return op.path.toLowerCase().includes(q) || op.summary.toLowerCase().includes(q);
    }
    return true;
  });

  useEffect(() => { setFindingPage(0); }, [findings.length, activeProject?.id]);

  if (!activeProject) return <NoProject />;

  const findingPages = Math.max(1, Math.ceil(findings.length / PAGE_SIZE));
  const safeFindingPage = Math.min(findingPage, findingPages - 1);
  const shownFindings = findings.slice(safeFindingPage * PAGE_SIZE, safeFindingPage * PAGE_SIZE + PAGE_SIZE);
  const opsPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safeOpsPage = Math.min(opsPage, opsPages - 1);
  const shownOps = filtered.slice(safeOpsPage * PAGE_SIZE, safeOpsPage * PAGE_SIZE + PAGE_SIZE);

  const sourceLabel: Record<string, string> = {
    'openapi-url': 'OpenAPI (URL)', upload: 'OpenAPI (file)', postman: 'Postman collection', docs: 'Docs',
  };

  return (
    <div className="space-y-6">
      <RealImportPanel projectId={activeProject.id} projectName={activeProject.name} />
      {/* Header */}
      <div>
        <h1 className="page-title">API source</h1>
        <p className="page-sub">
          Imported contract and machine-readable findings for {activeProject.name}.
        </p>
      </div>

      {/* Source */}
      <div className="card-pad">
        <SectionHeader
          title="Source"
          sub="Contract metadata captured at import time."
        />
        {activeProject.sourceKind ? (
          <dl>
            <KvRow k="Type">
              <Badge tone="blue">{sourceLabel[activeProject.sourceKind] ?? activeProject.sourceKind}</Badge>
            </KvRow>
            {activeProject.sourceDetail && (
              <KvRow k="Location">
                <span className="mono break-all">{activeProject.sourceDetail}</span>
              </KvRow>
            )}
            <KvRow k="Operations discovered">{ops.length.toLocaleString()}</KvRow>
          </dl>
        ) : (
          <EmptyState title="No source imported yet" sub="Import an OpenAPI spec or Postman collection from the new-project wizard." />
        )}
      </div>

      {/* Findings */}
      <div className="card-pad">
        <SectionHeader
          title="Findings"
          sub={`${openCount} open · ${resolvedCount} resolved`}
        />
        {findings.length === 0 ? (
          <EmptyState
            title="No findings yet"
            sub="Import a spec and the analysis findings will land here."
          />
        ) : (
        <>
        <ul className="divide-y divide-white/10">
          {shownFindings.map((f) => {
            const resolved = f.status === 'resolved';
            return (
              <li
                key={f.id}
                className={cn(
                  'flex items-start justify-between gap-4 py-4 first:pt-0 last:pb-0',
                  resolved && 'opacity-60',
                )}
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={f.severity === 'blocker' ? 'red' : 'amber'}>
                      {f.severity}
                    </Badge>
                    <Badge tone="gray" className="mono">
                      {f.code}
                    </Badge>
                  </div>
                  <div className="font-medium text-slate-100 mt-2">{f.title}</div>
                  <p className="text-sm text-slate-400 mt-1">{f.detail}</p>
                  {f.operationRef && (
                    <div className="mono text-slate-400 mt-1.5">{f.operationRef}</div>
                  )}
                </div>
                <div className="shrink-0">
                  {resolved ? (
                    <Badge tone="green">resolved</Badge>
                  ) : (
                    <button
                      type="button"
                      className="btn btn-sm btn-secondary disabled:opacity-40"
                      disabled={!access.canEdit}
                      title={access.readOnlyReason ?? undefined}
                      onClick={() => resolveFinding(f.id)}
                    >
                      <Check className="w-3.5 h-3.5" />
                      Mark resolved
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
        {findingPages > 1 && (
          <div className="flex items-center justify-between mt-4">
            <span className="text-sm text-slate-400">
              Showing {safeFindingPage * PAGE_SIZE + 1}–{Math.min(safeFindingPage * PAGE_SIZE + PAGE_SIZE, findings.length)} of {findings.length}
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                className="btn-sm btn-secondary disabled:opacity-40"
                disabled={safeFindingPage === 0}
                onClick={() => setFindingPage(safeFindingPage - 1)}
              >
                Previous
              </button>
              <button
                type="button"
                className="btn-sm btn-secondary disabled:opacity-40"
                disabled={safeFindingPage >= findingPages - 1}
                onClick={() => setFindingPage(safeFindingPage + 1)}
              >
                Next
              </button>
            </div>
          </div>
        )}
        </>
        )}
      </div>

      {/* Operation inventory */}
      <div className="card-pad">
        <SectionHeader
          title="Operation inventory"
          action={
            <span className="text-sm text-slate-400">
              Showing {filtered.length === 0 ? 0 : safeOpsPage * PAGE_SIZE + 1}–
              {Math.min(safeOpsPage * PAGE_SIZE + PAGE_SIZE, filtered.length)} of {filtered.length}
            </span>
          }
        />
        <p className="text-sm text-slate-400 mb-4">
          {ops.length} operations discovered — parsed from the imported specs.
        </p>

        {/* Filters */}
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3 mb-4">
          <div className="flex items-center gap-1.5">
            {(
              [
                ['all', 'All'],
                ['include', 'Include'],
                ['review', 'Needs review'],
                ['exclude', 'Exclude'],
              ] as [RecFilter, string][]
            ).map(([value, label]) => (
              <FilterButton
                key={value}
                active={recFilter === value}
                onClick={() => setRecFilter(value)}
              >
                {label}
              </FilterButton>
            ))}
          </div>
          <div className="flex items-center gap-1.5">
            {(
              [
                ['all', 'All effects'],
                ['READ', 'Read'],
                ['WRITE', 'Write'],
                ['DESTRUCTIVE', 'Destructive'],
              ] as [EffectFilter, string][]
            ).map(([value, label]) => (
              <FilterButton
                key={value}
                active={effectFilter === value}
                onClick={() => setEffectFilter(value)}
              >
                {label}
              </FilterButton>
            ))}
          </div>
          <div className="relative w-full sm:w-64 sm:ml-auto">
            <Search className="w-4 h-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              className="input pl-9"
              placeholder="Search path or summary…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>

        {/* Table */}
        {filtered.length === 0 ? (
          <EmptyState
            title="No operations match the current filters"
            sub="Clear the search or choose different filters to see results."
            action={
              <button
                type="button"
                className="btn-secondary btn-sm"
                onClick={() => { setRecFilter('all'); setEffectFilter('all'); setSearch(''); }}
              >
                Clear filters
              </button>
            }
          />
        ) : (
          <div className="overflow-x-auto -mx-5">
            <table className="w-full">
              <thead>
                <tr className="border-y border-white/10 bg-white/5">
                  <th className="table-th">Method</th>
                  <th className="table-th">Path</th>
                  <th className="table-th">Summary</th>
                  <th className="table-th">Effect</th>
                  <th className="table-th">Doc score</th>
                  <th className="table-th">Recommendation</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/10">
                {shownOps.map((op) => (
                  <tr key={op.fingerprint} className="hover:bg-white/5">
                    <td className="table-td">
                      <MethodBadge method={op.method} />
                    </td>
                    <td className="table-td">
                      <span className="mono whitespace-nowrap">{op.path}</span>
                    </td>
                    <td className="table-td text-slate-100">{op.summary}</td>
                    <td className="table-td">
                      <EffectBadge effect={op.effect} />
                    </td>
                    <td className="table-td">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-slate-100 w-7 text-right">
                          {op.docScore}
                        </span>
                        <div className="w-24">
                          <ProgressBar value={op.docScore} tone={docScoreTone(op.docScore)} />
                        </div>
                      </div>
                    </td>
                    <td className="table-td">
                      <Badge tone={recBadgeTone[op.recommendation]}>
                        {op.recommendation}
                      </Badge>
                      {op.excludeReason && (
                        <div className="text-xs text-slate-400 mt-1">
                          {op.excludeReason}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {filtered.length > 0 && opsPages > 1 && (
          <div className="flex items-center justify-between mt-4">
            <span className="text-sm text-slate-400">
              Page {safeOpsPage + 1} of {opsPages}
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                className="btn-sm btn-secondary disabled:opacity-40"
                disabled={safeOpsPage === 0}
                onClick={() => setOpsPage(safeOpsPage - 1)}
              >
                Previous
              </button>
              <button
                type="button"
                className="btn-sm btn-secondary disabled:opacity-40"
                disabled={safeOpsPage >= opsPages - 1}
                onClick={() => setOpsPage(safeOpsPage + 1)}
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
