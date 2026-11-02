import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, Eye, Info, ListChecks, Search, Wrench } from 'lucide-react';
import { useActiveProject, useFoundryStore, useProjectAccess } from '../../app/store';
import type { Finding, Severity } from '../../data/types';

/** Open-queue rows per page — the queue overwhelms past this. */
const PAGE_SIZE = 10;
import { Badge, EmptyState, ProgressBar } from '../../shared/components/atoms';
import NoProject from '../../shared/components/NoProject';
import ReadOnlyBanner from '../../shared/components/ReadOnlyBanner';
import { cn } from '../../shared/lib/utils';

// ─── Single review item ──────────────────────────────────────────────────────
// Review items come from the API: import findings (risk = blocker, ambiguity
// = warning) and eval ambiguities. Actionable items carry a suggested fix
// and are resolved (PATCH /review/:id). Informational items have no user
// action that could resolve them — they are shown as info and closed by
// acknowledging, not resolving.

function ReviewCard({
  item,
  toolName,
  onResolve,
  onAcknowledge,
  readOnlyReason,
  selected,
  onToggleSelect,
}: {
  item: Finding;
  /** Console tool name matching this item's operationRef, when one exists. */
  toolName?: string;
  onResolve: (id: string) => void;
  onAcknowledge: (id: string) => void;
  /** FE-09: non-null takes the decision controls away (viewer/read-only). */
  readOnlyReason?: string | null;
  /** Bulk selection (open queue only): checkbox state + toggle. */
  selected?: boolean;
  onToggleSelect?: (id: string) => void;
}) {
  const handled = item.status !== 'open';
  const informational = item.severity === 'info';
  return (
    <div className="card-pad">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <span className="inline-flex items-center gap-3">
          {onToggleSelect && (
            <input
              type="checkbox"
              className="h-4 w-4 accent-orange-400 cursor-pointer"
              checked={!!selected}
              disabled={!!readOnlyReason}
              title={readOnlyReason ?? 'Select for bulk action'}
              aria-label={`Select "${item.title}"`}
              onChange={() => onToggleSelect(item.id)}
            />
          )}
          <Badge
          tone={
            item.status === 'resolved'
              ? 'green'
              : item.status === 'acknowledged'
                ? 'gray'
                : informational
                  ? 'blue'
                  : item.severity === 'blocker'
                    ? 'red'
                    : 'amber'
          }
        >
          {item.status !== 'open' ? item.status : informational ? 'info' : item.severity}
          </Badge>
          {item.operationRef && <span className="mono text-sm text-slate-400">{item.operationRef}</span>}
        </span>
      </div>
      <div className="mt-2 font-medium text-slate-100">{item.title}</div>
      {item.detail && <p className="mt-1 text-sm text-slate-400">{item.detail}</p>}
      {!handled && item.recommendation && (
        <div className="mt-3 rounded-md bg-white/5 px-3 py-2 text-sm text-slate-300">
          <span className="inline-flex items-center gap-1.5 font-medium text-slate-100">
            {informational ? <Info className="w-3.5 h-3.5" /> : <Wrench className="w-3.5 h-3.5" />}
            {informational ? 'Good to know' : 'Suggested fix'}
          </span>
          <p className="mt-1">{item.recommendation}</p>
          {toolName && (
            <Link to={`/tools/${toolName}`} className="btn btn-secondary btn-sm mt-2">
              Confirm in Tools
            </Link>
          )}
        </div>
      )}
      {!handled && (
        <div className="mt-4">
          {informational ? (
            <button
              type="button"
              className="btn-secondary btn-sm disabled:opacity-40"
              disabled={!!readOnlyReason}
              title={readOnlyReason ?? undefined}
              onClick={() => onAcknowledge(item.id)}
            >
              <Eye className="w-3.5 h-3.5" />
              Acknowledge
            </button>
          ) : (
            <button
              type="button"
              className="btn-primary btn-sm disabled:opacity-40"
              disabled={!!readOnlyReason}
              title={readOnlyReason ?? undefined}
              onClick={() => onResolve(item.id)}
            >
              <Check className="w-3.5 h-3.5" />
              Mark resolved
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Review queue page ───────────────────────────────────────────────────────

export default function ReviewPage() {
  const [tab, setTab] = useState<'open' | 'resolved' | 'acknowledged'>('open');
  // Open-tab severity filter (blocker / warning / info) + pagination: the
  // full queue overwhelms, so the open tab shows 10 at a time.
  const [sevFilter, setSevFilter] = useState<'all' | Severity>('all');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const project = useActiveProject();
  const items = useFoundryStore((s) => s.findings);
  const tools = useFoundryStore((s) => s.tools);
  const toolBackendIds = useFoundryStore((s) => s.toolBackendIds);
  const resolveFinding = useFoundryStore((s) => s.resolveFinding);
  const acknowledgeFinding = useFoundryStore((s) => s.acknowledgeFinding);
  const resolveFindings = useFoundryStore((s) => s.resolveFindings);
  const acknowledgeFindings = useFoundryStore((s) => s.acknowledgeFindings);
  // Tool link for a suggested fix: prefer the item's backend tool id (eval
  // findings carry it; their evidence has no operationRef), falling back to
  // the import-time operationRef ("POST /batch") → tool upstream match.
  const toolNameFor = (q: Finding): string | undefined => {
    if (q.toolId) {
      const hit = Object.entries(toolBackendIds).find(([, id]) => id === q.toolId);
      if (hit) return hit[0];
    }
    return q.operationRef ? tools.find((t) => t.upstream === q.operationRef)?.name : undefined;
  };
  // FE-09: resolving a review item is a project mutation.
  const access = useProjectAccess();

  const openItems = items.filter((q) => q.status === 'open');
  const resolvedItems = items.filter((q) => q.status === 'resolved');
  const acknowledgedItems = items.filter((q) => q.status === 'acknowledged');
  const handledItems = [...resolvedItems, ...acknowledgedItems];
  const tabItems = tab === 'open' ? openItems : tab === 'resolved' ? resolvedItems : acknowledgedItems;
  // Severity sub-filter applies to the open tab only — handled tabs stay whole.
  const visible = tab === 'open' && sevFilter !== 'all'
    ? tabItems.filter((q) => q.severity === sevFilter)
    : tabItems;
  // Text search across title, detail, code, operation and linked tool name.
  const q = search.trim().toLowerCase();
  const searched = q
    ? visible.filter((item) =>
        item.title.toLowerCase().includes(q) ||
        item.detail.toLowerCase().includes(q) ||
        item.code.toLowerCase().includes(q) ||
        (item.operationRef ?? '').toLowerCase().includes(q) ||
        (toolNameFor(item) ?? '').toLowerCase().includes(q))
    : visible;
  const total = items.length;

  // Page + selection reset whenever the list identity changes.
  useEffect(() => {
    setPage(0);
    setSelected(new Set());
  }, [tab, sevFilter, search, project?.id, searched.length]);

  const pages = Math.max(1, Math.ceil(searched.length / PAGE_SIZE));
  const safePage = Math.min(page, pages - 1);
  const shownItems = searched.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);

  const sevCount = (s: Severity) => openItems.filter((q) => q.severity === s).length;
  const toggleSelect = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const selectedIds = [...selected].filter((id) => searched.some((q) => q.id === id));

  // Below every hook: no-project renders the placeholder instead of the queue.
  if (!project) return <NoProject />;

  return (
    <div>
      {/* Header */}
      <div className="mb-6">
        <h1 className="page-title">Review queue</h1>
        <p className="page-sub">
          Findings from import and evaluation. Blockers and warnings carry a suggested fix and are
          resolved; informational items need no action — acknowledge them once you've seen them.
          Nothing ships with an open blocker.
        </p>
      </div>

      <div className="mb-6">
        <ReadOnlyBanner reason={access.readOnlyReason} />
      </div>

      {/* Progress */}
      <div className="card-pad mb-6">
        <div className="flex items-center gap-2 mb-3">
          <ListChecks className="w-4 h-4 text-orange-300" />
          <span className="text-sm font-medium text-slate-100">
            {handledItems.length} of {total} handled
            {total > 0 && (
              <span className="text-slate-400">
                {' '}({resolvedItems.length} resolved · {acknowledgedItems.length} acknowledged)
              </span>
            )}
          </span>
        </div>
        <ProgressBar value={total === 0 ? 0 : (handledItems.length / total) * 100} />
      </div>

      {/* Filter tabs */}
      <div className="inline-flex rounded-lg bg-white/10 p-1 mb-4">
        {(['open', 'resolved', 'acknowledged'] as const).map((t) => {
          const count = t === 'open' ? openItems.length : t === 'resolved' ? resolvedItems.length : acknowledgedItems.length;
          return (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={cn(
                'px-3.5 py-1.5 rounded-md text-sm font-medium transition-colors',
                tab === t
                  ? 'bg-neon/15 border border-neon/30 text-neon'
                  : 'text-slate-400 hover:text-slate-300',
              )}
            >
              {t === 'open' ? 'Open' : t === 'resolved' ? 'Resolved' : 'Acknowledged'}
              <span
                className={cn(
                  'ml-1.5 text-xs font-semibold',
                  tab === t ? 'text-slate-400' : 'text-slate-500',
                )}
              >
                {count}
              </span>
            </button>
          );
        })}
      </div>

      {/* Severity sub-filter (open tab): blocker / warning / info */}
      {tab === 'open' && openItems.length > 0 && (
        <div className="inline-flex rounded-lg bg-white/5 p-1 mb-5 ml-0 sm:ml-3">
          {(['all', 'blocker', 'warning', 'info'] as const).map((s) => {
            const count = s === 'all' ? openItems.length : sevCount(s);
            return (
              <button
                key={s}
                type="button"
                onClick={() => setSevFilter(s)}
                className={cn(
                  'px-3 py-1 rounded-md text-xs font-medium transition-colors',
                  sevFilter === s
                    ? 'bg-white/15 text-slate-100'
                    : 'text-slate-500 hover:text-slate-300',
                )}
              >
                {s === 'all' ? 'All' : s === 'blocker' ? 'Blockers' : s === 'warning' ? 'Warnings' : 'Info'}
                <span className="ml-1.5 text-[11px] font-semibold text-slate-500">
                  {count}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {/* Search the queue (title, detail, code, operation, tool) */}
      <div className="relative w-full sm:w-72 mb-4">
        <Search className="w-4 h-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
        <input
          type="text"
          className="input pl-9"
          placeholder="Search reviews…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {/* Bulk bar (open tab): acknowledge or resolve many together */}
      {tab === 'open' && searched.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 mb-4">
          <button
            type="button"
            className="btn-sm btn-secondary disabled:opacity-40"
            disabled={!access.canEdit}
            title={access.readOnlyReason ?? 'Select every item in this filter, on all pages'}
            onClick={() => setSelected(new Set(searched.map((q) => q.id)))}
          >
            Select all
          </button>
          <span className="text-sm text-slate-400">
            {selectedIds.length > 0 ? `${selectedIds.length} selected` : 'Select items to act on many at once'}
          </span>
          <span className="flex-1" />
          <button
            type="button"
            className="btn-sm btn-secondary disabled:opacity-40"
            disabled={selectedIds.length === 0 || !access.canEdit}
            title={access.readOnlyReason ?? 'Acknowledge every selected item'}
            onClick={() => { acknowledgeFindings(selectedIds); setSelected(new Set()); }}
          >
            Acknowledge selected
          </button>
          <button
            type="button"
            className="btn-sm btn-secondary disabled:opacity-40"
            disabled={!access.canEdit}
            title={access.readOnlyReason ?? 'Acknowledge every item in this filter, on all pages'}
            onClick={() => { acknowledgeFindings(searched.map((q) => q.id)); setSelected(new Set()); }}
          >
            Acknowledge all
          </button>
          <button
            type="button"
            className="btn-sm btn-primary disabled:opacity-40"
            disabled={selectedIds.length === 0 || !access.canEdit}
            title={access.readOnlyReason ?? 'Resolve every selected item'}
            onClick={() => { resolveFindings(selectedIds); setSelected(new Set()); }}
          >
            Resolve selected
          </button>
        </div>
      )}

      {searched.length === 0 ? (
        tab === 'open' ? (
          openItems.length === 0 ? (
            <EmptyState
              title="Review queue clear"
              sub="Nothing needs a decision. Tools are ready for the next stage — evaluation."
              action={
                <Link to="/evaluate" className="btn-secondary btn-sm">
                  Go to evaluation
                </Link>
              }
            />
          ) : q ? (
            <EmptyState
              title="No reviews match the search"
              sub="Clear the search or choose different filters to see results."
              action={
                <button className="btn-secondary btn-sm" onClick={() => setSearch('')}>
                  Clear search
                </button>
              }
            />
          ) : (
            <EmptyState
              title={`No open ${sevFilter === 'blocker' ? 'blockers' : sevFilter === 'warning' ? 'warnings' : 'info items'}`}
              sub="Nothing in this severity needs a decision right now."
            />
          )
        ) : (
          <EmptyState
            title={tab === 'resolved' ? 'Nothing resolved yet' : 'Nothing acknowledged yet'}
            sub={tab === 'resolved' ? 'Items you resolve will appear here.' : 'Informational items you acknowledge will appear here.'}
          />
        )
      ) : (
        <>
          <div className="space-y-4">
            {shownItems.map((q) => (
              <ReviewCard
                key={q.id}
                item={q}
                toolName={toolNameFor(q)}
                onResolve={resolveFinding}
                onAcknowledge={acknowledgeFinding}
                readOnlyReason={access.canEdit ? null : access.readOnlyReason}
                selected={selected.has(q.id)}
                onToggleSelect={tab === 'open' ? toggleSelect : undefined}
              />
            ))}
          </div>
          {pages > 1 && (
            <div className="flex items-center justify-between mt-5">
              <span className="text-sm text-slate-400">
                Showing {safePage * PAGE_SIZE + 1}–{Math.min(safePage * PAGE_SIZE + PAGE_SIZE, searched.length)} of {searched.length}
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
        </>
      )}
    </div>
  );
}
