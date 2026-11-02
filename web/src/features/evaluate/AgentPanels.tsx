import { Fragment, useEffect, useState, type ElementType } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Bot, Check, ChevronDown, Lightbulb, Plus, Sparkles, X } from 'lucide-react';
import {
  acceptSuggestion, agentTaskFlips, compareAgentRuns, createAgentTask, deleteAgentTask, generateAgentTasks,
  generateSuggestions, listAgentResults, listAgentTasks, listSuggestions, rejectSuggestion, suggestionTarget,
  updateAgentTask, type AgentResult, type AgentSuiteSummary, type AgentTask, type AgentTranscript, type FixSuggestion,
} from '../../data/agent';
import type { BackendEvalRun } from '../../data/api';
import { downloadDiagnostics } from '../../shared/lib/diagnostics';
import { Badge, EmptyState, SectionHeader } from '../../shared/components/atoms';
import { cn } from '../../shared/lib/utils';

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ─── EV-08: agent tasks ────────────────────────────────────────────────────

/**
 * The natural-language tasks an agent performs with this project's tools on
 * every evaluation. A model can propose them; nothing runs until approved.
 */
export function AgentTasksPanel({ projectId, canEdit, bare, onCounts }: {
  projectId: string; canEdit: boolean; bare?: boolean;
  onCounts?: (counts: { proposed: number; approved: number }) => void;
}) {
  const [tasks, setTasks] = useState<AgentTask[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  const load = () => listAgentTasks(projectId).then((r) => setTasks(r.tasks)).catch((e) => setError(errText(e)));
  useEffect(() => { setTasks(null); void load(); }, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  const proposed = tasks?.filter((t) => t.status === 'proposed') ?? [];
  const approved = tasks?.filter((t) => t.status === 'approved') ?? [];
  useEffect(() => {
    onCounts?.({ proposed: proposed.length, approved: approved.length });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proposed.length, approved.length]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try { await fn(); await load(); } catch (e) { setError(errText(e)); } finally { setBusy(false); }
  };

  const Wrapper = (bare ? Fragment : 'section') as ElementType;
  const wrapperProps = bare ? {} : { className: 'card-pad' };

  return (
    <Wrapper {...wrapperProps}>
      <SectionHeader
        title="Agent tasks"
        sub="Requests an AI agent completes with these tools on every evaluation — the before/after measure of agent behavior."
        action={canEdit ? (
          <button type="button" className="btn btn-secondary btn-sm" disabled={busy}
            onClick={() => void act(() => generateAgentTasks(projectId))}>
            <Sparkles className="h-4 w-4" />
            {busy ? 'Working…' : 'Propose tasks'}
          </button>
        ) : undefined}
      />
      {error && (
        <div className="mb-3 space-y-2">
          <p className="text-sm text-red-300">{error}</p>
          <button
            type="button"
            className="btn btn-sm btn-secondary"
            onClick={() => downloadDiagnostics()}
            title="Download clicks + API calls with timings and request ids as JSON"
          >
            Download diagnostics
          </button>
        </div>
      )}
      {tasks && tasks.length === 0 && (
        <EmptyState title="No agent tasks yet" sub="Propose tasks from your tools, or write the requests your users make." />
      )}
      {proposed.length > 0 && (
        <div className="mb-4">
          <h3 className="text-xs uppercase tracking-wide text-slate-500 mb-2">Proposed — review before they run</h3>
          <div className="space-y-2">
            {proposed.map((t) => (
              <TaskRow key={t.id} task={t}>
                {canEdit && (
                  <div className="flex gap-2 shrink-0">
                    <button type="button" className="btn btn-sm btn-secondary" disabled={busy}
                      onClick={() => void act(() => updateAgentTask(projectId, t.id, { status: 'approved' }))}>
                      <Check className="h-3.5 w-3.5" /> Approve
                    </button>
                    <button type="button" className="btn btn-sm btn-ghost" disabled={busy}
                      onClick={() => void act(() => updateAgentTask(projectId, t.id, { status: 'rejected' }))}>
                      <X className="h-3.5 w-3.5" /> Reject
                    </button>
                  </div>
                )}
              </TaskRow>
            ))}
          </div>
        </div>
      )}
      {approved.length > 0 && (
        <p className="text-xs text-slate-500 mb-2">
          Approved tasks run in every evaluation&apos;s agent task suite — which needs a language model
          on the server (CF_LLM_API_KEY). Without one the suite reports “not tested” and nothing executes.
        </p>
      )}
      {approved.length > 0 && (
        <div className="space-y-2">
          {approved.map((t) => (
            <TaskRow key={t.id} task={t}>
              {canEdit && (
                <button type="button" className="btn btn-sm btn-ghost shrink-0" disabled={busy}
                  onClick={() => void act(() => deleteAgentTask(projectId, t.id))}>
                  Remove
                </button>
              )}
            </TaskRow>
          ))}
        </div>
      )}
      {canEdit && (
        <form
          className="flex flex-col sm:flex-row gap-2 mt-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!draft.trim()) return;
            void act(async () => { await createAgentTask(projectId, { prompt: draft.trim() }); setDraft(''); });
          }}
        >
          <label htmlFor="agent-task-prompt" className="sr-only">New agent task</label>
          <input id="agent-task-prompt" className="input flex-1" value={draft} maxLength={1000}
            onChange={(e) => setDraft(e.target.value)} placeholder="A request a user would make, in their words" />
          <button type="submit" className="btn btn-secondary btn-sm" disabled={busy || !draft.trim()}>
            <Plus className="h-4 w-4" /> Add task
          </button>
        </form>
      )}
    </Wrapper>
  );
}

function TaskRow({ task, children }: { task: AgentTask; children?: React.ReactNode }) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-start gap-3 rounded-lg border border-white/10 px-3 py-2.5">
      <Bot className="h-4 w-4 text-neon shrink-0 mt-0.5 hidden sm:block" />
      <div className="flex-1 min-w-0">
        <p className="text-sm text-slate-100">{task.prompt}</p>
        <div className="flex flex-wrap gap-1.5 mt-1.5 text-xs">
          {task.expected_tools.map((n) => <Badge key={n} tone="green">uses {n}</Badge>)}
          {task.forbidden_tools.map((n) => <Badge key={n} tone="red">never {n}</Badge>)}
          {task.source === 'llm' && <Badge tone="purple">proposed by {task.model ?? 'model'}</Badge>}
        </div>
        {task.answer_rubric && <p className="text-xs text-slate-500 mt-1">Good answer: {task.answer_rubric}</p>}
      </div>
      {children}
    </div>
  );
}

// ─── before / after ─────────────────────────────────────────────────────────

function agentOf(run: BackendEvalRun | null | undefined): AgentSuiteSummary | undefined {
  return (run?.summary as { agent?: AgentSuiteSummary } | undefined)?.agent;
}

const fmt = (v: number | undefined, unit: string) => (v === undefined ? '—' : `${v.toLocaleString()}${unit}`);

/**
 * Agent behavior for the selected run against the previous one: success
 * rate, tool-call quality and cost, then each task's flip with transcripts
 * side by side.
 */
export function AgentComparisonPanel({ projectId, run, previous }: {
  projectId: string;
  run: BackendEvalRun;
  previous: BackendEvalRun | null;
}) {
  const [after, setAfter] = useState<AgentResult[]>([]);
  const [before, setBefore] = useState<AgentResult[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const summary = agentOf(run);
  const prevSummary = agentOf(previous);

  useEffect(() => {
    listAgentResults(projectId, run.id).then((r) => setAfter(r.results)).catch(() => setAfter([]));
    if (previous) listAgentResults(projectId, previous.id).then((r) => setBefore(r.results)).catch(() => setBefore([]));
    else setBefore([]);
  }, [projectId, run.id, previous?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!summary) return null;
  if (summary.status === 'not_tested') {
    return (
      <section className="card-pad">
        <SectionHeader title="Agent behavior" sub="How an AI agent does with these tools." />
        <p className="text-sm text-slate-400">{summary.reason}</p>
      </section>
    );
  }
  const rows = compareAgentRuns(prevSummary, summary);
  const flips = agentTaskFlips(before, after);

  return (
    <section className="card-pad">
      <SectionHeader
        title="Agent behavior"
        sub={previous && prevSummary?.metrics
          ? 'This run against the previous one — same tasks, the tools as they were then and as they are now.'
          : 'Re-run the evaluation after changing tools to see the before / after.'}
        action={<Badge tone="blue">{summary.model}</Badge>}
      />
      <div className="overflow-x-auto mb-5">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-slate-500 border-b border-white/10">
              <th className="py-2 pr-4 font-medium">Measure</th>
              {prevSummary?.metrics && <th className="py-2 pr-4 font-medium">Before</th>}
              <th className="py-2 pr-4 font-medium">{prevSummary?.metrics ? 'After' : 'This run'}</th>
              {prevSummary?.metrics && <th className="py-2 font-medium">Change</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.label} className="border-b border-white/5">
                <td className="py-2 pr-4 text-slate-300">{r.label}</td>
                {prevSummary?.metrics && <td className="py-2 pr-4 mono text-slate-400">{fmt(r.before, r.unit)}</td>}
                <td className="py-2 pr-4 mono text-slate-100">{fmt(r.after, r.unit)}</td>
                {prevSummary?.metrics && (
                  <td className={cn('py-2 mono', r.improved === true && 'text-emerald-300', r.improved === false && 'text-red-300', r.improved === null && 'text-slate-500')}>
                    {r.delta === null || r.delta === 0 ? '—' : `${r.delta > 0 ? '+' : ''}${r.delta}${r.unit}`}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="space-y-2">
        {flips.map((f) => (
          <div key={f.taskId} className="rounded-lg border border-white/10">
            <button type="button" onClick={() => setOpen(open === f.taskId ? null : f.taskId)}
              className="w-full flex items-center gap-3 px-3 py-2 text-left hover:bg-white/5">
              <FlipBadge change={f.change} />
              <span className="flex-1 min-w-0 text-sm text-slate-200 truncate">{f.prompt}</span>
              <ChevronDown className={cn('h-4 w-4 text-slate-500 transition-transform', open === f.taskId && 'rotate-180')} />
            </button>
            {open === f.taskId && (
              <div className={cn('grid gap-3 p-3 border-t border-white/10', f.before ? 'md:grid-cols-2' : 'grid-cols-1')}>
                {f.before && <TranscriptView label="Before" result={f.before} />}
                <TranscriptView label={f.before ? 'After' : 'This run'} result={f.after} />
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

function FlipBadge({ change }: { change: ReturnType<typeof agentTaskFlips>[number]['change'] }) {
  const meta = {
    fixed: ['green', 'Fixed'], regressed: ['red', 'Regressed'], still_passing: ['green', 'Pass'],
    still_failing: ['red', 'Fail'], new: ['blue', 'New'],
  } as const;
  const [tone, label] = meta[change];
  return <Badge tone={tone}>{label}</Badge>;
}

export function TranscriptView({ label, result, transcript }: { label: string; result?: AgentResult; transcript?: AgentTranscript }) {
  const t = transcript ?? result?.transcript ?? null;
  if (!t) return null;
  return (
    <div className="min-w-0">
      <div className="flex items-center justify-between gap-2 mb-2">
        <span className="text-xs uppercase tracking-wide text-slate-500">{label}</span>
        {result && <Badge tone={result.passed ? 'green' : 'red'}>{result.passed ? 'passed' : 'failed'}</Badge>}
      </div>
      <ol className="space-y-1.5 text-xs">
        {t.steps.flatMap((s) => s.toolCalls).map((c) => (
          <li key={c.id} className="rounded-md bg-white/5 px-2 py-1.5">
            <div className="flex items-center gap-2">
              <span className={cn('mono', c.known ? 'text-slate-200' : 'text-red-300')}>{c.name}</span>
              <span className="mono text-slate-500 truncate">{JSON.stringify(c.args)}</span>
            </div>
            <div className={cn('mt-0.5', c.result.ok ? 'text-slate-500' : 'text-red-300')}>
              {c.result.dryRun ? 'not sent (write tool, dry run)' : c.result.ok ? `ok${c.result.status ? ` · ${c.result.status}` : ''} · ${c.result.latencyMs}ms` : c.result.error}
            </div>
          </li>
        ))}
      </ol>
      <p className="text-sm text-slate-200 mt-2 whitespace-pre-wrap break-words">{t.finalAnswer || <em className="text-slate-500">No answer ({t.stoppedBy})</em>}</p>
      {result && result.checks.filter((c) => !c.passed).map((c) => (
        <p key={c.name} className="text-xs text-red-300 mt-1">{c.name.replace(/_/g, ' ')}{c.detail ? `: ${c.detail}` : ''}</p>
      ))}
      <p className="text-[11px] text-slate-500 mt-2">{t.model} · {(t.usage.inputTokens + t.usage.outputTokens).toLocaleString()} tokens · {t.durationMs}ms</p>
    </div>
  );
}

// ─── HK-09: suggested fixes ─────────────────────────────────────────────────

/**
 * Model-proposed edits to the text agents read, each tied to the evidence it
 * fixes. Accepting edits the tool and sends it back for approval; the next
 * evaluation and release measure the effect.
 */
export function SuggestionsPanel({ projectId, canEdit, bare, onCounts }: {
  projectId: string; canEdit: boolean; bare?: boolean;
  onCounts?: (counts: { open: number; accepted: number }) => void;
}) {
  const [items, setItems] = useState<FixSuggestion[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [edits, setEdits] = useState<Record<string, string>>({});

  const load = () => listSuggestions(projectId).then((r) => setItems(r.suggestions)).catch((e) => setError(errText(e)));
  useEffect(() => { setItems(null); void load(); }, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    setNote(null);
    try { await fn(); await load(); } catch (e) { setError(errText(e)); } finally { setBusy(false); }
  };

  const open = items?.filter((s) => s.status === 'proposed') ?? [];
  const accepted = items?.filter((s) => s.status === 'accepted') ?? [];
  useEffect(() => {
    onCounts?.({ open: open.length, accepted: accepted.length });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open.length, accepted.length]);

  // Bare (embedded in a side panel): the outer section owns the title, so
  // only the action survives as a compact row.
  const suggestAction = canEdit ? (
    <button type="button" className="btn btn-secondary btn-sm" disabled={busy}
      onClick={() => void act(async () => {
        const r = await generateSuggestions(projectId);
        setNote(r.message ?? (r.suggestions.length ? null : 'No edits proposed for the current evidence.'));
      })}>
      <Lightbulb className="h-4 w-4" />
      {busy ? 'Working…' : 'Suggest fixes'}
    </button>
  ) : undefined;

  const Wrapper = (bare ? Fragment : 'section') as ElementType;
  const wrapperProps = bare ? {} : { className: 'card-pad' };

  return (
    <Wrapper {...wrapperProps}>
      {bare ? (
        <div className="flex justify-end mb-3">{suggestAction}</div>
      ) : (
        <SectionHeader
          title="Suggested fixes"
          sub="Edits to what agents read, proposed from review findings, failed scenarios and failed agent tasks. Nothing applies until you accept it."
          action={suggestAction}
        />
      )}
      {error && <p className="text-sm text-red-300 mb-3">{error}</p>}
      {note && <p className="text-sm text-slate-400 mb-3">{note}</p>}
      {items && open.length === 0 && accepted.length === 0 && !note && (
        <EmptyState title="No suggestions yet" sub="Run an evaluation, then ask for fixes based on what failed." />
      )}
      <div className="space-y-3">
        {open.map((s) => (
          <div key={s.id} className="rounded-lg border border-white/10 p-3">
            <div className="flex flex-wrap items-center gap-2 mb-2">
              <span className="mono text-sm text-slate-100">{s.tool_name}</span>
              <Badge tone="purple">{suggestionTarget(s)}</Badge>
              {s.evidence.length > 0 && <span className="text-xs text-slate-500">{s.evidence.length} evidence item(s)</span>}
            </div>
            <div className="grid gap-2 md:grid-cols-2 text-sm">
              <div className="rounded-md bg-red-500/5 border border-red-400/20 p-2">
                <div className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">Now</div>
                <p className="text-slate-300 whitespace-pre-wrap break-words">{s.before_text || <em className="text-slate-500">empty</em>}</p>
              </div>
              <div className="rounded-md bg-emerald-500/5 border border-emerald-400/20 p-2">
                <div className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">Suggested</div>
                {canEdit ? (
                  <textarea className="input w-full min-h-[72px] text-sm" aria-label="Suggested text"
                    value={edits[s.id] ?? s.after_text} onChange={(e) => setEdits({ ...edits, [s.id]: e.target.value })} />
                ) : (
                  <p className="text-slate-100 whitespace-pre-wrap break-words">{s.after_text}</p>
                )}
              </div>
            </div>
            {s.rationale && <p className="text-xs text-slate-400 mt-2">Why: {s.rationale}</p>}
            {canEdit && (
              <div className="flex gap-2 mt-3">
                <button type="button" className="btn btn-sm btn-primary" disabled={busy}
                  onClick={() => void act(() => acceptSuggestion(projectId, s.id, edits[s.id]))}>
                  <Check className="h-3.5 w-3.5" /> Accept
                </button>
                <button type="button" className="btn btn-sm btn-ghost" disabled={busy}
                  onClick={() => void act(() => rejectSuggestion(projectId, s.id))}>
                  <X className="h-3.5 w-3.5" /> Reject
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
      {accepted.length > 0 && (
        <Fragment>
          <p className="text-sm text-slate-300 mt-4">
            {accepted.length} accepted fix(es) are waiting for approval. Approve the edited tools, re-run the evaluation to
            measure the effect, then cut a release.
          </p>
          <Link to="/tools" className="btn btn-secondary btn-sm mt-2 inline-flex">
            Review edited tools <ArrowRight className="h-4 w-4" />
          </Link>
        </Fragment>
      )}
    </Wrapper>
  );
}
