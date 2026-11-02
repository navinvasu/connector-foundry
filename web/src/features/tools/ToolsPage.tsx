import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, RotateCcw, Search, XCircle } from 'lucide-react';
import { useActiveProject, useFoundryStore, useProjectAccess } from '../../app/store';
import NoProject from '../../shared/components/NoProject';
import ReadOnlyBanner from '../../shared/components/ReadOnlyBanner';
import JobProgress from '../../shared/components/JobProgress';
import { useQueueJobs } from '../../data/queueJobs';
import type { AgentTool } from '../../data/types';
import { matchesSearch, parseSearchTerms } from './toolSearch';
import { Badge, EffectBadge, EmptyState } from '../../shared/components/atoms';
import { cn } from '../../shared/lib/utils';

type StatusFilter = 'all' | 'approved' | 'needs_review' | 'excluded';

const statusTone: Record<AgentTool['status'], 'green' | 'amber' | 'gray' | 'blue'> = {
  approved: 'green',
  needs_review: 'amber',
  excluded: 'gray',
  draft: 'blue',
};

const statusLabel: Record<AgentTool['status'], string> = {
  approved: 'Approved',
  needs_review: 'Needs review',
  excluded: 'Excluded',
  draft: 'Draft',
};

const filterDefs: { key: StatusFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'approved', label: 'Approved' },
  { key: 'needs_review', label: 'Needs review' },
  { key: 'excluded', label: 'Excluded' },
];

export default function ToolsPage() {
  const tools = useFoundryStore((s) => s.tools);
  const approveTool = useFoundryStore((s) => s.approveTool);
  const excludeTool = useFoundryStore((s) => s.excludeTool);
  const reopenTool = useFoundryStore((s) => s.reopenTool);
  // FE-09: viewers get the same table with the actions explained away.
  const access = useProjectAccess();
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [search, setSearch] = useState('');
  // The table paginates at 10 rows; page resets on filter/search/project change.
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const project = useActiveProject();
  useEffect(() => { setPage(0); setSelected(new Set()); }, [filter, search, project?.id]);
  const approveTools = useFoundryStore((s) => s.approveTools);
  const loadProject = useFoundryStore((s) => s.loadProject);
  // A compile running anywhere (fresh import, another tab) means the table
  // below is mid-build — show the job, not a "0 tools" empty state.
  const compileJobs = useQueueJobs(project?.id ?? null, ['compile'], () => {
    if (project) void loadProject(project.id);
  });
  // Fresh data on arrival: the store may predate an import/compile that
  // finished elsewhere (another tab, the onboarding wizard) — the queue
  // hook only refires on transitions it observes, so without this the
  // table sits stale behind the manual Reload button.
  useEffect(() => {
    if (project) void loadProject(project.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id]);
  const activeCompile = compileJobs[0] ?? null;
  const toggleSelect = (name: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  const counts: Record<StatusFilter, number> = {
    all: tools.length,
    approved: tools.filter((t) => t.status === 'approved').length,
    needs_review: tools.filter((t) => t.status === 'needs_review').length,
    excluded: tools.filter((t) => t.status === 'excluded').length,
  };

  const filtered = filter === 'all' ? tools : tools.filter((t) => t.status === filter);
  // One substring per line: a pasted list finds every listed tool (OR).
  const terms = parseSearchTerms(search);
  const visible = terms.length > 0
    ? filtered.filter((t) => matchesSearch(t, terms))
    : filtered;
  const PAGE_SIZE = 10;
  const pages = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const safePage = Math.min(page, pages - 1);
  const shownTools = visible.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);
  const selectedNames = [...selected].filter((n) => visible.some((t) => t.name === n));

  // The table is empty for four different reasons — say which, so "0 tools"
  // never reads as a finished empty project while work is still in flight.
  const emptyBody = terms.length > 0 || filter !== 'all' ? (
    <EmptyState
      title={terms.length > 0 ? 'No tools match the search' : 'No tools in this state'}
      sub={terms.length > 0 ? 'Clear the search or choose a different filter to see results.' : 'Tools move here as you approve, exclude, or reopen them.'}
      action={
        terms.length > 0 ? (
          <button className="btn-secondary btn-sm" onClick={() => { setSearch(''); setFilter('all'); }}>
            Clear search
          </button>
        ) : filter !== 'all' ? (
          <button className="btn-secondary btn-sm" onClick={() => setFilter('all')}>
            Show all tools
          </button>
        ) : undefined
      }
    />
  ) : activeCompile ? (
    <EmptyState
      title="Compiling tool drafts…"
      sub="The import landed and the compile job is running — the table fills in when it finishes. Large specs take a few minutes; watch the progress above."
    />
  ) : (project?.toolsTotal ?? 0) > 0 ? (
    <EmptyState
      title="Tools are still loading"
      sub="The project holds tools that haven't reached this screen yet — reload to fetch them."
      action={
        <button className="btn-secondary btn-sm" onClick={() => { if (project) void loadProject(project.id); }}>
          Reload tools
        </button>
      }
    />
  ) : (project?.operationsCount ?? 0) > 0 ? (
    <EmptyState
      title="No tool drafts yet"
      sub="The import finished but nothing is compiled — start the compile from the Import screen and the drafts appear here."
      action={
        <Link to="/import" className="btn-secondary btn-sm">
          Go to Import
        </Link>
      }
    />
  ) : (
    <EmptyState
      title="No tools yet"
      sub="Import an API spec first — each operation becomes one tool draft."
      action={
        <Link to="/import" className="btn-secondary btn-sm">
          Go to Import
        </Link>
      }
    />
  );

  const handleExclude = (name: string) => {
    const reason = window.prompt('Why is this tool being excluded?');
    excludeTool(name, reason || 'Excluded by reviewer');
  };

  if (!project) return <NoProject />;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="page-title">Tools</h1>
        <p className="page-sub">
          {tools.length} agent actions proposed. Nothing ships without your approval.
        </p>
      </div>

      <ReadOnlyBanner reason={access.readOnlyReason} />

      {activeCompile && (
        <div className="space-y-2">
          <JobProgress job={activeCompile} />
          {tools.length === 0 && (
            <p className="text-sm text-slate-400">
              Compiling operations into tool drafts — the table fills in when the job finishes.
              Large specs take a few minutes.
            </p>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {filterDefs.map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={cn('btn-sm', filter === f.key ? 'btn-primary' : 'btn-secondary')}
          >
            {f.label} ({counts[f.key]})
          </button>
        ))}
        <div className="relative w-full sm:w-64 sm:ml-auto">
          <Search className="w-4 h-4 text-slate-500 absolute left-3 top-3" />
          <textarea
            className="input pl-9 resize-y"
            rows={2}
            placeholder="Search name or upstream — one per line for many…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {terms.length > 1 && (
            <p className="text-[11px] text-slate-500 mt-1">{terms.length} search terms</p>
          )}
        </div>
        {visible.length > 0 && (
          <span className="text-sm text-slate-400">
            Showing {safePage * PAGE_SIZE + 1}–{Math.min(safePage * PAGE_SIZE + PAGE_SIZE, visible.length)} of {visible.length}
          </span>
        )}
      </div>

      {visible.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="btn-sm btn-secondary disabled:opacity-40"
            disabled={!access.canEdit}
            title={access.readOnlyReason ?? 'Select every tool in this filter, on all pages'}
            onClick={() => setSelected(new Set(visible.map((t) => t.name)))}
          >
            Select all
          </button>
          <span className="text-sm text-slate-400">
            {selectedNames.length > 0 ? `${selectedNames.length} selected` : 'Select tools to approve many at once'}
          </span>
          <span className="flex-1" />
          <button
            type="button"
            className="btn-sm btn-secondary disabled:opacity-40"
            disabled={selectedNames.length === 0 || !access.canEdit}
            title={access.readOnlyReason ?? 'Approve every selected tool'}
            onClick={() => { approveTools(selectedNames); setSelected(new Set()); }}
          >
            Approve selected
          </button>
          <button
            type="button"
            className="btn-sm btn-primary disabled:opacity-40"
            disabled={!access.canEdit}
            title={access.readOnlyReason ?? 'Approve every tool in this filter, on all pages'}
            onClick={() => { approveTools(visible.map((t) => t.name)); setSelected(new Set()); }}
          >
            Approve all
          </button>
        </div>
      )}

      {visible.length === 0 ? emptyBody : (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto"><table className="w-full">
            <thead>
              <tr className="border-b border-white/10 bg-white/5">
                <th className="table-th w-10">
                  <span className="sr-only">Select</span>
                </th>
                <th className="table-th">Tool</th>
                <th className="table-th">Effect</th>
                <th className="table-th">Status</th>
                <th className="table-th">Confirmation / Idempotency</th>
                <th className="table-th text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {shownTools.map((tool) => (
                <tr key={tool.name} className="border-b border-white/10 last:border-0 hover:bg-white/5">
                  <td className="table-td">
                    <input
                      type="checkbox"
                      checked={selected.has(tool.name)}
                      disabled={!access.canEdit}
                      onChange={() => toggleSelect(tool.name)}
                      aria-label={`Select ${tool.name}`}
                    />
                  </td>
                  <td className="table-td">
                    <Link
                      to={`/tools/${tool.name}`}
                      className="mono font-medium text-orange-300 hover:text-orange-300 hover:underline"
                    >
                      {tool.name}
                    </Link>
                    <div className="mono text-slate-400 mt-0.5">{tool.upstream}</div>
                  </td>
                  <td className="table-td">
                    <EffectBadge effect={tool.effect} />
                  </td>
                  <td className="table-td">
                    <Badge tone={statusTone[tool.status]}>{statusLabel[tool.status]}</Badge>
                    {tool.status === 'excluded' && tool.excludeReason && (
                      <div className="text-xs text-slate-400 mt-1">{tool.excludeReason}</div>
                    )}
                  </td>
                  <td className="table-td">
                    <div className="text-xs text-slate-400">Confirmation: {tool.confirmation}</div>
                    <div className="text-xs text-slate-400">Idempotency: {tool.idempotency}</div>
                  </td>
                  <td className="table-td">
                    <div className="flex justify-end gap-2">
                      {(tool.status === 'needs_review' || tool.status === 'draft') && (
                        <button className="btn-sm btn-primary disabled:opacity-40" onClick={() => approveTool(tool.name)} disabled={!access.canEdit} title={access.readOnlyReason ?? undefined}>
                          <Check size={14} /> Approve
                        </button>
                      )}
                      {tool.status !== 'excluded' && (
                        <button className="btn-sm btn-secondary disabled:opacity-40" onClick={() => handleExclude(tool.name)} disabled={!access.canEdit} title={access.readOnlyReason ?? undefined}>
                          <XCircle size={14} /> Exclude
                        </button>
                      )}
                      {tool.status === 'excluded' && (
                        <button className="btn-sm btn-ghost disabled:opacity-40" onClick={() => reopenTool(tool.name)} disabled={!access.canEdit} title={access.readOnlyReason ?? undefined}>
                          <RotateCcw size={14} /> Reopen
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table></div>
        </div>
      )}
      {pages > 1 && (
        <div className="flex items-center justify-between">
          <span className="text-sm text-slate-400">
            Page {safePage + 1} of {pages}
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              className="btn-sm btn-secondary disabled:opacity-40"
              disabled={safePage === 0}
              onClick={() => setPage(safePage - 1)}
            >
              Previous
            </button>
            <button
              type="button"
              className="btn-sm btn-secondary disabled:opacity-40"
              disabled={safePage >= pages - 1}
              onClick={() => setPage(safePage + 1)}
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
