import { Fragment, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, ChevronDown, Download, FlaskConical, ShieldCheck, XCircle } from 'lucide-react';
import type { EvalCategory, EvalRun, EvalScenario } from '../../data/types';
import {
  enqueueEval,
  pollJob,
  listEvalRuns,
  getEvalRun,
  getEvalReport,
  listProjectTools,
  listEvalScenarios,
  createEvalScenario,
  updateEvalScenario,
  deleteEvalScenario,
  mapBackendEvalRun,
  evalScenarioLabel,
  type Job,
  type BackendEvalRun,
  type BackendEvalResult,
  type BackendCertification,
  type BackendCustomScenario,
} from '../../data/api';
import { diffEvalResults, newFailureKeys, type EvalDiff } from './evalDiff';
import { formatRunDateTime, scenarioGuidance, type EvalOutcome } from './evalOutcome';
import { keepPassedTools } from '../../data/api';
import { listAgentTasks, listSuggestions } from '../../data/agent';
import { AgentComparisonPanel, AgentTasksPanel, SuggestionsPanel } from './AgentPanels';
import { useActiveProject, useFoundryStore, useProjectAccess } from '../../app/store';
import NoProject from '../../shared/components/NoProject';
import ReadOnlyBanner from '../../shared/components/ReadOnlyBanner';
import SidePanel from '../../shared/components/SidePanel';
import JobProgress from '../../shared/components/JobProgress';
import { useQueueJobs, isJobActive } from '../../data/queueJobs';
import { Badge, EmptyState, ErrorState, KvRow, LoadingState, ProgressBar, SectionHeader, StatCard } from '../../shared/components/atoms';
import { cn } from '../../shared/lib/utils';

const categoryMeta: Record<EvalCategory, { label: string; tone: 'blue' | 'purple' | 'amber' | 'green' }> = {
  selection: { label: 'Selection', tone: 'blue' },
  arguments: { label: 'Arguments', tone: 'purple' },
  safety: { label: 'Safety', tone: 'amber' },
  execution: { label: 'Execution', tone: 'green' },
  recovery: { label: 'Recovery', tone: 'blue' },
};

/** Passed-only outcome: N operations found, P passed, F failed — with why
 *  the failures failed and the action to continue with the passed ones. */
function OutcomePanel({ outcome, projectId, runId, canEdit, evalRunning }: {
  outcome: EvalOutcome; projectId: string; runId: string; canEdit: boolean;
  /** An evaluation is still in flight: keep-passed would act on partial
   *  results (and the POST can fail), so the button stays disabled. */
  evalRunning?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Which operation list the side panel shows — opened by clicking one of
  // the three labels above. Null means the panel is closed.
  const [panelFilter, setPanelFilter] = useState<'all' | 'passed' | 'failed' | null>(null);

  const keepPassed = async () => {
    setBusy(true); setError(null);
    try {
      const r = await keepPassedTools(projectId, runId);
      setDone(`Continuing with ${r.kept_tools.length} passed operation(s) (${r.kept_tools.join(', ') || 'none'}). ` +
        `${r.excluded_tools.length} failed operation(s) set aside — they no longer block the release. ` +
        'Re-approve any of them in Tools to try again.');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  return (
    <section className="card-pad">
      <SectionHeader
        title="Operations outcome"
        sub={`${outcome.total} operations evaluated · ${outcome.passed} passed · ${outcome.failed} failed. Only the passed operations need to continue — the rest can be set aside with their reasons.`}
      />
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mt-4">
        <StatCard label="Operations found" value={String(outcome.total)} sub="click to list all"
          selected={panelFilter === 'all'} onClick={() => setPanelFilter('all')} />
        <StatCard label="Passed" value={String(outcome.passed)} sub="promoted to tested · click to list"
          selected={panelFilter === 'passed'} onClick={() => setPanelFilter('passed')} />
        <StatCard label="Failed" value={String(outcome.failed)} sub="click to list"
          selected={panelFilter === 'failed'} onClick={() => setPanelFilter('failed')} />
      </div>

      {outcome.failuresByCategory.length > 0 && (
        <div className="space-y-3 mt-6">
          <div className="label">Why the failures failed — and what to do</div>
          {outcome.failuresByCategory.map((c) => (
            <div key={c.category} className="flex items-start gap-3 rounded-lg border border-white/10 px-3 py-2">
              <AlertTriangle className="h-4 w-4 text-amber-400 shrink-0 mt-0.5" />
              <div className="min-w-0">
                <div className="text-sm font-medium text-slate-100">
                  {c.label} <span className="text-slate-400">· {c.tool_count} operation{c.tool_count === 1 ? '' : 's'}</span>
                </div>
                <p className="text-sm text-slate-400 mt-0.5">{c.suggestion}</p>
              </div>
            </div>
          ))}
        </div>
      )}

      {panelFilter && (
        <SidePanel
          title={
            panelFilter === 'all' ? `All operations (${outcome.total})`
            : panelFilter === 'passed' ? `Passed operations (${outcome.passed})`
            : `Failed operations (${outcome.failedTools.length})`
          }
          sub={
            panelFilter === 'all'
              ? 'Every evaluated operation — passed first, then failed with scenario counts.'
              : panelFilter === 'passed'
                ? 'Operations where every recorded scenario passed — these continue to Publish.'
                : 'Every failed operation with its failing scenario count — newest run.'
          }
          onClose={() => setPanelFilter(null)}
        >
          {(panelFilter === 'all' || panelFilter === 'passed') && (
            <div className="space-y-2">
              {outcome.passedTools.map((t) => (
                <div key={t.tool_id} className="flex items-center justify-between gap-3 rounded-lg border border-white/10 px-3 py-2">
                  <span className="text-sm font-medium text-slate-100 break-words">{t.tool_name}</span>
                  <Badge tone="green">passed</Badge>
                </div>
              ))}
              {outcome.passedTools.length === 0 && outcome.passed > 0 && (
                <p className="text-xs text-slate-500">
                  This run finished before passed-operation names were stored — counts only. Re-run the evaluation to list them.
                </p>
              )}
            </div>
          )}
          {(panelFilter === 'all' || panelFilter === 'failed') && (
            <div className={panelFilter === 'all' && outcome.passedTools.length > 0 ? 'space-y-2 mt-2' : 'space-y-2'}>
              {outcome.failedTools.map((t) => (
                <div key={t.tool_id} className="flex items-center justify-between gap-3 rounded-lg border border-white/10 px-3 py-2">
                  <span className="text-sm font-medium text-slate-100 break-words">{t.tool_name}</span>
                  <Badge tone="red">{t.failed_scenarios} failed</Badge>
                </div>
              ))}
            </div>
          )}
          {panelFilter === 'failed' && (
            <p className="text-xs text-slate-500">
              Fix the top failure reason above (usually the API key or its plan), then re-run evaluation.
            </p>
          )}
        </SidePanel>
      )}

      {error && <p className="text-sm text-red-300 mt-4">{error}</p>}
      {done ? (
        <div className="mt-5 flex flex-wrap items-center gap-3">
          <p className="text-sm text-emerald-300">{done}</p>
          <Link to="/publish" className="btn btn-primary btn-sm">Continue to Publish</Link>
        </div>
      ) : outcome.failed > 0 && outcome.passed > 0 ? (
        <div className="mt-5 flex flex-wrap items-center gap-3">
          <button
            type="button"
            className="btn-primary btn-sm disabled:opacity-40"
            disabled={busy || !canEdit || !!evalRunning}
            title={evalRunning ? 'Evaluation still running — this unlocks when it finishes.' : undefined}
            onClick={() => keepPassed().catch(() => {})}
          >
            {busy ? 'Setting aside…' : `Continue with the ${outcome.passed} passed operation${outcome.passed === 1 ? '' : 's'} only`}
          </button>
          <span className="text-xs text-slate-500">
            {evalRunning
              ? 'Evaluation still running — this unlocks when the run finishes.'
              : 'Failed operations go back to candidate: out of the release, still listed with their reasons.'}
          </span>
        </div>
      ) : outcome.passed === 0 && outcome.failed > 0 ? (
        <p className="text-sm text-amber-300 mt-5">No operation passed, so there is nothing to continue with yet — fix the top failure reason above (usually the API key or its plan), then re-run evaluation.</p>
      ) : null}
    </section>
  );
}

/** Expected vs actual, diagnosis and failure trace for one scenario —
 *  shared by the matrix expanded row and the failed-scenarios panel so
 *  both show the same evidence. */
function ScenarioDetail({ s }: { s: EvalScenario }) {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <div className="label">Expected</div>
          <div className="mono bg-ink-950 border border-white/10 rounded-lg p-3 text-xs text-slate-300 break-words">
            {s.expected}
          </div>
        </div>
        <div>
          <div className="label">Actual</div>
          <div className="mono bg-ink-950 border border-white/10 rounded-lg p-3 text-xs text-slate-300 break-words">
            {s.actual}
          </div>
        </div>
      </div>

      {s.diagnosis && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 flex items-start gap-3">
          <AlertTriangle className="h-5 w-5 text-amber-600 shrink-0 mt-0.5" />
          <div>
            <div className="text-sm font-semibold text-amber-900">Diagnosis</div>
            <p className="text-sm text-amber-800 mt-1">{s.diagnosis}</p>
          </div>
        </div>
      )}

      {s.trace && s.trace.length > 0 && (
        <div>
          <div className="label mb-1">Failure trace</div>
          <div className="code-block space-y-1.5">
            {s.trace.map((step, i) => (
              <div key={i} className="flex items-start gap-3">
                <span className="mono text-slate-500 shrink-0">{step.t}</span>
                <span className="text-slate-100">{step.event}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** Run summary + suggested fixes + scenario matrix. */
function RunDetail({ run, highlightKeys, projectId, canEdit, evalRunning }: {
  run: EvalRun; highlightKeys?: Set<string>; projectId?: string; canEdit?: boolean;
  evalRunning?: boolean;
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [failedOpen, setFailedOpen] = useState(false);
  const [matrixOpen, setMatrixOpen] = useState(false);
  const passRate = run.scenarioCount > 0 ? Math.round((run.passCount / run.scenarioCount) * 100) : 0;
  const failedScenarios = run.scenarios.filter((s) => s.result === 'fail');
  // An "open related review question" button only makes sense when a matching
  // open review item actually exists — otherwise it is a dead end. Match on
  // the backend tool id the eval recorded for the scenario.
  // Select the raw array (stable reference) and derive in render: an inline
  // `.filter` selector returns a fresh array on every snapshot check, and
  // zustand's default Object.is comparison then re-renders forever
  // ("Maximum update depth exceeded" via forceStoreRerender).
  const findings = useFoundryStore((s) => s.findings);
  const openFindings = useMemo(
    () => findings.filter((f) => f.status === 'open' && f.toolId),
    [findings],
  );
  const relatedFor = (toolId: string | null | undefined) =>
    toolId ? openFindings.filter((f) => f.toolId === toolId) : [];
  // Tool id → display name, so a failed scenario can name the API it ran
  // against (older runs stored ids only — those fall back to a short id).
  const toolNames = useMemo(() => {
    const m = new Map<string, string>();
    for (const t of run.outcome?.passedTools ?? []) m.set(t.tool_id, t.tool_name);
    for (const t of run.outcome?.failedTools ?? []) m.set(t.tool_id, t.tool_name);
    return m;
  }, [run.outcome]);
  const toolNameFor = (toolId: string | null | undefined) =>
    toolId ? (toolNames.get(toolId) ?? `tool ${toolId.slice(0, 8)}`) : 'unknown tool';

  return (
    <Fragment>
      {/* ── Run summary ─────────────────────────────────────────────────── */}
      <section className="card-pad">
        <dl>
          <KvRow k="Run ID">
            <span className="mono">{run.id}</span>
          </KvRow>
          <KvRow k="Started">{run.startedAt}</KvRow>
          <KvRow k="Sandbox">
            <span className="mono">{run.sandbox}</span>
          </KvRow>
        </dl>

        {run.outcome && projectId && (
          <div className="mt-5"><OutcomePanel outcome={run.outcome} projectId={projectId} runId={run.id} canEdit={!!canEdit} evalRunning={evalRunning} /></div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mt-5">
          <StatCard label="Pass rate" value={`${passRate}%`} sub={`${run.passCount} of ${run.scenarioCount}`} />
          <StatCard label="Scenarios" value={String(run.scenarioCount)} />
          <StatCard label="Failures" value={String(run.failCount)} />
        </div>

        <div className="mt-6 space-y-3">
          {run.byCategory.map((c) => (
            <div key={c.category} className="flex items-center gap-4">
              <div className="w-28 text-sm font-medium text-slate-300">{categoryMeta[c.category].label}</div>
              <div className="flex-1">
                <ProgressBar
                  value={c.total > 0 ? (c.pass / c.total) * 100 : 0}
                  tone={c.pass === c.total ? 'green' : c.pass === 0 ? 'red' : 'amber'}
                />
              </div>
              <div className="mono text-sm text-slate-400 w-14 text-right">
                {c.pass}/{c.total}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ── Failed scenarios: a section box like Agent tasks; the full list ── */}
      {/* opens in a side panel so the screen never reloads or stretches.     */}
      <section className="card-pad">
        <SectionHeader
          title={`Failed scenarios (${failedScenarios.length})`}
          sub="What failed, why, and what to do — a review link appears only when a matching open review question exists."
          action={failedScenarios.length > 0 ? (
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setFailedOpen(true)}>
              Show all {failedScenarios.length}
            </button>
          ) : undefined}
        />
        {failedScenarios.length === 0 && (
          <EmptyState title="No failures" sub="All scenarios passed — nothing to fix." />
        )}
      </section>
      {failedOpen && (
        <SidePanel
          title={`Failed scenarios (${failedScenarios.length})`}
          sub="Every failed scenario with its diagnosis — newest selection."
          onClose={() => setFailedOpen(false)}
        >
          <div className="space-y-3">
            {failedScenarios.map((s) => {
              const related = relatedFor(s.toolId);
              const guidance = scenarioGuidance(s);
              const isNewFailure = !!s.key && !!highlightKeys?.has(s.key);
              return (
                <div key={s.id} className="card-pad border-l-4 border-l-amber-400 bg-amber-50/40">
                  <div className="flex items-start gap-3">
                    <AlertTriangle className="h-5 w-5 text-amber-600 shrink-0 mt-0.5" />
                    <div className="flex-1 min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-semibold text-slate-100">{s.name}</span>
                        <Badge tone={categoryMeta[s.category].tone}>{categoryMeta[s.category].label}</Badge>
                        {isNewFailure && <Badge tone="red">New failure</Badge>}
                      </div>
                      <div className="mt-1 text-xs">
                        <span className="mono text-slate-950">{toolNameFor(s.toolId)}</span>
                      </div>
                      <div className="truncate text-xs text-slate-950 mt-0.5" title={s.input}>
                        Input: {s.input}
                      </div>
                      <div className="mt-3">
                        <ScenarioDetail s={s} />
                      </div>
                      {guidance && <p className="text-sm text-slate-200 mt-3">{guidance}</p>}
                      {related.length > 0 && (
                        <Link to="/review" className="btn btn-secondary btn-sm mt-3">
                          Open related review question{related.length > 1 ? ` (${related.length})` : ''}
                        </Link>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </SidePanel>
      )}

      {/* ── Scenario matrix: a section box like Agent tasks; the full table ── */}
      {/* opens in a side panel instead of stretching the screen.             */}
      <section className="card-pad">
        <SectionHeader
          title={`Scenario matrix (${run.scenarioCount})`}
          sub={`${run.passCount} passed · ${run.failCount} failed — every simulated sandbox run, with expected vs actual and failure traces.`}
          action={run.scenarios.length > 0 ? (
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setMatrixOpen(true)}>
              Show full list
            </button>
          ) : undefined}
        />
      </section>
      {matrixOpen && (
        <SidePanel
          title={`Scenario matrix (${run.scenarios.length})`}
          sub="Every simulated sandbox run — select a row for expected vs actual and failure traces."
          onClose={() => setMatrixOpen(false)}
        >
        <div className="card overflow-hidden">
          <div className="overflow-x-auto"><table className="w-full">
            <thead className="bg-white/5 border-b border-white/10">
              <tr>
                <th className="table-th">Scenario</th>
                <th className="table-th">Category</th>
                <th className="table-th">Input</th>
                <th className="table-th">Result</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/10">
              {run.scenarios.map((s) => {
                const expanded = expandedId === s.id;
                const isNewFailure = !!s.key && !!highlightKeys?.has(s.key);
                return (
                  <Fragment key={s.id}>
                    <tr
                      key={s.id}
                      onClick={() => setExpandedId(expanded ? null : s.id)}
                      className={cn('hover:bg-white/5 cursor-pointer', isNewFailure && 'bg-red-500/10')}
                    >
                      <td className="table-td">
                        <span className="inline-flex items-center gap-2">
                          <ChevronDown
                            className={cn('h-4 w-4 text-slate-500 transition-transform', expanded && 'rotate-180')}
                          />
                          <span className="font-medium text-slate-100">{s.name}</span>
                        </span>
                      </td>
                      <td className="table-td">
                        <Badge tone={categoryMeta[s.category].tone}>{categoryMeta[s.category].label}</Badge>
                      </td>
                      <td className="table-td">
                        <span className="block max-w-xs truncate text-sm text-slate-400" title={s.input}>
                          {s.input}
                        </span>
                      </td>
                      <td className="table-td">
                        <span className="inline-flex items-center gap-2">
                          <Badge tone={s.result === 'pass' ? 'green' : 'red'}>{s.result}</Badge>
                          {isNewFailure && <Badge tone="red">New failure</Badge>}
                        </span>
                      </td>
                    </tr>
                    {expanded && (
                      <tr key={`${s.id}-detail`}>
                        <td colSpan={4} className="px-4 py-4 bg-white/5/60">
                          <ScenarioDetail s={s} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table></div>
        </div>
        </SidePanel>
      )}
    </Fragment>
  );
}

const changeKindMeta: Record<EvalDiff['changes'][number]['kind'], { label: string; tone: 'red' | 'green' | 'blue' | 'gray' }> = {
  regression: { label: 'Regression', tone: 'red' },
  new_failure: { label: 'New failure', tone: 'red' },
  fixed: { label: 'Fixed', tone: 'green' },
  added: { label: 'Added', tone: 'blue' },
  removed: { label: 'Removed', tone: 'gray' },
};

function outcomeText(state: 'pass' | 'fail' | 'absent'): string {
  return state === 'pass' ? 'passing' : state === 'fail' ? 'failing' : 'not present';
}

/**
 * EV-02: what changed versus the previous run — new failures first and
 * loud. The section shows only the count and a one-line summary; the full
 * change list opens in a side panel like Agent tasks.
 */
function EvalDiffPanel({ diff, previousRun }: { diff: EvalDiff; previousRun: BackendEvalRun }) {
  const [open, setOpen] = useState(false);
  const delta = diff.passRateDelta;
  const passPct = diff.currentTotal > 0 ? Math.round((diff.currentPass / diff.currentTotal) * 100) : 0;
  const summaryBits = [
    `pass rate ${passPct}% (${diff.currentPass}/${diff.currentTotal})`,
    delta === null ? null : delta > 0 ? `up ${delta} pts` : delta < 0 ? `down ${Math.abs(delta)} pts` : 'pass rate unchanged',
    diff.newFailures.length > 0 ? `${diff.newFailures.length} new failure${diff.newFailures.length === 1 ? '' : 's'}` : 'no new failures',
    diff.fixed.length > 0 ? `${diff.fixed.length} fixed` : null,
    diff.stillFailing > 0 ? `${diff.stillFailing} still failing` : null,
  ].filter((b): b is string => b !== null);
  const title = `Changes vs previous run (${diff.changes.length})`;
  const sub = `Compared with run ${previousRun.id.slice(0, 8)} · ${formatRunDateTime(previousRun.started_at)} — ${summaryBits.join(' · ')}.`;
  return (
    <section className="card-pad">
      <SectionHeader
        title={title}
        sub={sub}
        action={diff.changes.length > 0 ? (
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setOpen(true)}>
            Show all changes
          </button>
        ) : undefined}
      />
      {diff.changes.length === 0 && (
        <p className="text-sm text-slate-400 mt-4">
          No changes — every scenario behaved exactly as in the previous run.
        </p>
      )}
      {open && (
        <SidePanel
          title={title}
          sub={sub}
          onClose={() => setOpen(false)}
        >
          <div className="flex flex-wrap items-center gap-2">
            {delta !== null && (
              <Badge tone={delta > 0 ? 'green' : delta < 0 ? 'red' : 'gray'}>
                {delta > 0 ? `↑ ${delta} pts` : delta < 0 ? `↓ ${Math.abs(delta)} pts` : '→ no change'}
              </Badge>
            )}
            {diff.newFailures.length > 0 ? (
              <Badge tone="red">{diff.newFailures.length} new failure{diff.newFailures.length === 1 ? '' : 's'}</Badge>
            ) : (
              <Badge tone="green">No new failures</Badge>
            )}
            {diff.fixed.length > 0 && <Badge tone="green">{diff.fixed.length} fixed</Badge>}
            {diff.stillFailing > 0 && <Badge tone="gray">{diff.stillFailing} still failing</Badge>}
            {diff.added.length > 0 && <Badge tone="blue">{diff.added.length} added</Badge>}
            {diff.removed.length > 0 && <Badge tone="gray">{diff.removed.length} removed</Badge>}
          </div>
          <div className="space-y-2 mt-4">
            {diff.changes.map((c) => {
              const meta = changeKindMeta[c.kind];
              const loud = c.kind === 'regression' || c.kind === 'new_failure';
              return (
                <div
                  key={c.key}
                  className={cn(
                    'flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border px-3 py-2',
                    loud ? 'border-red-400/40 bg-red-500/10' : 'border-white/10',
                  )}
                >
                  <Badge tone={meta.tone}>{meta.label}</Badge>
                  <span className="text-sm font-medium text-slate-100">{evalScenarioLabel(c.scenario)}</span>
                  <span className="text-xs text-slate-500">
                    {c.suite}
                    {c.toolId ? ` · tool ${c.toolId.slice(0, 8)}` : ''}
                  </span>
                  <span className="text-xs text-slate-400 ml-auto">
                    {outcomeText(c.before)} → {outcomeText(c.after)}
                  </span>
                </div>
              );
            })}
          </div>
        </SidePanel>
      )}
    </section>
  );
}

/**
 * A run's details without replacing the screen. History entries open here;
 * the main content stays pinned to the latest run. Completed runs show
 * stats, changes vs the previous run and failures; in-progress runs show
 * live status with a refresh action.
 */
function RunSidePanel({ runMeta, previousMeta, onClose }: {
  runMeta: BackendEvalRun; previousMeta: BackendEvalRun | null; onClose: () => void;
}) {
  const [run, setRun] = useState<EvalRun | null>(null);
  const [diff, setDiff] = useState<EvalDiff | null>(null);
  const [prevSummary, setPrevSummary] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const { run: br, results } = await getEvalRun(runMeta.id);
      setRun(mapBackendEvalRun(br, results));
      if (previousMeta) {
        const prev = await getEvalRun(previousMeta.id);
        const prevMapped = mapBackendEvalRun(prev.run, prev.results);
        setPrevSummary(`${prevMapped.passCount}/${prevMapped.scenarioCount} passed`);
        setDiff(diffEvalResults(prev.results, results));
      } else {
        setPrevSummary(null);
        setDiff(null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setRun(null);
    setDiff(null);
    setPrevSummary(null);
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runMeta.id]);

  const inProgress = runMeta.status !== 'passed' && runMeta.status !== 'failed';
  return (
    <SidePanel
      title={`Run ${runMeta.id.slice(0, 8)}`}
      sub={`${formatRunDateTime(runMeta.started_at)}${previousMeta ? ` · vs previous ${previousMeta.id.slice(0, 8)}` : ' · first run'}`}
      onClose={onClose}
    >
      <div>
        <Badge tone={runMeta.status === 'passed' ? 'green' : runMeta.status === 'failed' ? 'red' : 'blue'}>
          {runMeta.status}
        </Badge>
      </div>
      {loading ? (
        <LoadingState label="Loading run details…" />
      ) : error ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : inProgress ? (
        <div className="card-pad">
          <p className="text-sm text-slate-300">This run is still in progress — full details land here when it finishes.</p>
          {prevSummary && <p className="text-xs text-slate-500 mt-2">Previous run baseline: {prevSummary}.</p>}
          <button type="button" className="btn-secondary btn-sm mt-3" onClick={() => void load()}>
            Refresh
          </button>
        </div>
      ) : run ? (
        <Fragment>
          <div className="grid grid-cols-3 gap-3">
            <StatCard label="Pass rate" value={`${run.scenarioCount > 0 ? Math.round((run.passCount / run.scenarioCount) * 100) : 0}%`} sub={`${run.passCount} of ${run.scenarioCount}`} />
            <StatCard label="Failed" value={String(run.failCount)} />
            <StatCard label="Scenarios" value={String(run.scenarioCount)} />
          </div>
          {diff && previousMeta && <EvalDiffPanel diff={diff} previousRun={previousMeta} />}
          {run.scenarios.filter((s) => s.result === 'fail').length > 0 && (
            <div>
              <div className="label mb-2">Failed scenarios</div>
              <div className="space-y-2">
                {run.scenarios.filter((s) => s.result === 'fail').map((s) => (
                  <div key={s.id} className="rounded-lg border border-white/10 px-3 py-2">
                    <div className="text-sm font-medium text-slate-100">{s.name}</div>
                    {s.diagnosis && <p className="text-xs text-slate-400 mt-0.5">{s.diagnosis}</p>}
                  </div>
                ))}
              </div>
            </div>
          )}
          {run.outcome && run.outcome.failedTools.length > 0 && (
            <div>
              <div className="label mb-2">Failed operations</div>
              <div className="flex flex-wrap gap-2">
                {run.outcome.failedTools.map((t) => (
                  <Badge key={t.tool_id} tone="red">{t.tool_name} ({t.failed_scenarios})</Badge>
                ))}
              </div>
            </div>
          )}
        </Fragment>
      ) : null}
    </SidePanel>
  );
}

/** EV-05: what "Certified" means — every check, pass or fail, in the open. */
function CertificationPanel({ cert }: { cert: BackendCertification }) {
  const passing = cert.checks.filter((c) => c.status === 'pass').length;
  return (
    <section className="card-pad">
      <SectionHeader
        title="Certification"
        sub={`Judged under criteria ${cert.criteria_version}. The Certified badge appears only when every check passes.`}
      />
      <div className="flex flex-wrap items-center gap-2 mt-1">
        {cert.certified ? (
          <Badge tone="green">
            <span className="inline-flex items-center gap-1">
              <ShieldCheck className="h-3.5 w-3.5" />
              Certified
            </span>
          </Badge>
        ) : (
          <Badge tone="gray">Not certified</Badge>
        )}
        <span className="text-sm text-slate-400">
          {passing}/{cert.checks.length} checks passing
        </span>
      </div>
      <div className="space-y-2 mt-4">
        {cert.checks.map((c) => (
          <div
            key={c.id}
            className={cn(
              'flex items-start gap-3 rounded-lg border px-3 py-2',
              c.status === 'pass' ? 'border-white/10' : 'border-red-400/40 bg-red-500/10',
            )}
          >
            {c.status === 'pass' ? (
              <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0 mt-0.5" />
            ) : (
              <XCircle className="h-4 w-4 text-red-400 shrink-0 mt-0.5" />
            )}
            <div className="min-w-0">
              <div className="text-sm font-medium text-slate-100">{c.label}</div>
              <div className="text-xs text-slate-400 mt-0.5">{c.detail}</div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

/** EV-04: the owner's own cases — given args → expect shape/status. */
function CustomScenariosPanel({ projectId, canEdit, bare, onCounts }: {
  projectId: string; canEdit: boolean; bare?: boolean;
  /** Reports the scenario count for the selected tool (null while loading). */
  onCounts?: (count: number | null) => void;
}) {
  const [tools, setTools] = useState<Array<{ id: string; name: string; status: string }> | null>(null);
  const [toolId, setToolId] = useState<string>('');
  const [scenarios, setScenarios] = useState<BackendCustomScenario[] | null>(null);
  const [name, setName] = useState('');
  const [givenArgsText, setGivenArgsText] = useState('{}');
  const [expectStatus, setExpectStatus] = useState('');
  const [expectKeys, setExpectKeys] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    setTools(null);
    setToolId('');
    setScenarios(null);
    listProjectTools(projectId)
      .then(({ tools: fresh }) => {
        if (!live) return;
        setTools(fresh);
        setToolId(fresh[0]?.id ?? '');
      })
      .catch((e) => { if (live) { setTools([]); setError(e instanceof Error ? e.message : String(e)); } });
    return () => { live = false; };
  }, [projectId]);

  useEffect(() => {
    if (!toolId) { setScenarios(null); return; }
    let live = true;
    setScenarios(null);
    listEvalScenarios(projectId, toolId)
      .then(({ scenarios: fresh }) => { if (live) setScenarios(fresh); })
      .catch((e) => { if (live) { setScenarios([]); setError(e instanceof Error ? e.message : String(e)); } });
    return () => { live = false; };
  }, [projectId, toolId]);

  useEffect(() => {
    onCounts?.(scenarios === null ? null : scenarios.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scenarios]);

  const create = async () => {
    let givenArgs: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(givenArgsText);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object');
      givenArgs = parsed as Record<string, unknown>;
    } catch {
      setError('Given args must be a JSON object, e.g. {"latitude": 52.52}.');
      return;
    }
    const statusText = expectStatus.trim();
    const statusNum = statusText === '' ? null : Number(statusText);
    if (statusNum !== null && (!Number.isInteger(statusNum) || statusNum < 100 || statusNum > 599)) {
      setError('Expected status must be an HTTP status (100–599), or blank for 2xx.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { scenario } = await createEvalScenario(projectId, toolId, {
        name: name.trim(),
        given_args: givenArgs,
        expect_status: statusNum,
        expect_body_keys: expectKeys.split(',').map((k) => k.trim()).filter(Boolean),
      });
      setScenarios((prev) => [...(prev ?? []), scenario]);
      setName('');
      setGivenArgsText('{}');
      setExpectStatus('');
      setExpectKeys('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (scenario: BackendCustomScenario) => {
    try {
      const { scenario: updated } = await updateEvalScenario(projectId, toolId, scenario.id, { enabled: !scenario.enabled });
      setScenarios((prev) => (prev ?? []).map((s) => (s.id === updated.id ? updated : s)));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const remove = async (scenario: BackendCustomScenario) => {
    try {
      await deleteEvalScenario(projectId, toolId, scenario.id);
      setScenarios((prev) => (prev ?? []).filter((s) => s.id !== scenario.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const Wrapper = (bare ? Fragment : 'section') as React.ElementType;
  const wrapperProps = bare ? {} : { className: 'card-pad' };

  return (
    <Wrapper {...wrapperProps}>
      <SectionHeader
        title="Custom scenarios"
        sub="Your own edge cases (given args → expect shape/status). Enabled scenarios run in every evaluation and gate release like a built-in failure."
      />
      {error && <p className="text-sm text-red-300 mt-2">{error}</p>}
      {tools === null ? (
        <LoadingState label="Loading tools…" />
      ) : tools.length === 0 ? (
        <EmptyState title="No tools yet" sub="Compile tools first — custom scenarios attach to a tool." />
      ) : (
        <Fragment>
          <label className="label" htmlFor="custom-tool">Tool</label>
          <select
            id="custom-tool"
            className="input w-full sm:w-72"
            value={toolId}
            onChange={(e) => setToolId(e.target.value)}
          >
            {tools.map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>

          {scenarios === null ? (
            <LoadingState label="Loading scenarios…" />
          ) : scenarios.length === 0 ? (
            <EmptyState title="No custom scenarios for this tool" sub="Add one below — it runs from the next evaluation." />
          ) : (
            <div className="space-y-2 mt-4">
              {scenarios.map((s) => (
                <div key={s.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-white/10 px-3 py-2">
                  <Badge tone={s.enabled ? 'green' : 'gray'}>{s.enabled ? 'enabled' : 'disabled'}</Badge>
                  <span className="text-sm font-medium text-slate-100">{s.name}</span>
                  <span className="text-xs text-slate-400">
                    expect {s.expect_status ?? '2xx'}
                    {s.expect_body_keys.length > 0 ? ` · keys ${s.expect_body_keys.join(', ')}` : ''}
                  </span>
                  {canEdit && (
                    <span className="ml-auto flex gap-2">
                      <button type="button" className="btn btn-secondary btn-sm" onClick={() => toggle(s).catch(() => {})}>
                        {s.enabled ? 'Disable' : 'Enable'}
                      </button>
                      <button type="button" className="btn btn-secondary btn-sm" onClick={() => remove(s).catch(() => {})}>
                        Delete
                      </button>
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}

          {canEdit && (
            <form
              className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-4"
              onSubmit={(e) => { e.preventDefault(); void create(); }}
            >
              <div>
                <label className="label" htmlFor="custom-name">Scenario name</label>
                <input id="custom-name" className="input w-full" value={name} onChange={(e) => setName(e.target.value)} placeholder="Happy path with required arguments" required maxLength={120} />
              </div>
              <div>
                <label className="label" htmlFor="custom-status">Expected status (blank = 2xx)</label>
                <input id="custom-status" className="input w-full" value={expectStatus} onChange={(e) => setExpectStatus(e.target.value)} placeholder="200" inputMode="numeric" />
              </div>
              <div className="sm:col-span-2">
                <label className="label" htmlFor="custom-args">Given args (JSON object)</label>
                <textarea id="custom-args" className="input mono w-full" rows={3} value={givenArgsText} onChange={(e) => setGivenArgsText(e.target.value)} />
              </div>
              <div className="sm:col-span-2">
                <label className="label" htmlFor="custom-keys">Expected body keys (comma-separated, optional)</label>
                <input id="custom-keys" className="input w-full" value={expectKeys} onChange={(e) => setExpectKeys(e.target.value)} placeholder="current, hourly" />
              </div>
              <div>
                <button type="submit" disabled={busy || !name.trim()} className="btn-primary btn-sm disabled:opacity-40">
                  {busy ? 'Adding…' : 'Add scenario'}
                </button>
              </div>
            </form>
          )}
        </Fragment>
      )}
    </Wrapper>
  );
}

/** Live evaluation for a real backend project: runs go through the job queue. */
function RealEvaluate({ projectId, projectName }: { projectId: string; projectName: string }) {
  const [runs, setRuns] = useState<BackendEvalRun[] | null>(null);
  const [selectedRun, setSelectedRun] = useState<BackendEvalRun | null>(null);
  const [run, setRun] = useState<EvalRun | null>(null);
  const [currentResults, setCurrentResults] = useState<BackendEvalResult[]>([]);
  const [previous, setPrevious] = useState<{ run: BackendEvalRun; results: BackendEvalResult[] } | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [jobError, setJobError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reportBusy, setReportBusy] = useState(false);
  const [reportError, setReportError] = useState<string | null>(null);
  // Side-panel run inspection: history entries open details here instead of
  // replacing the screen. The main content stays pinned to the latest run.
  const [panelRunId, setPanelRunId] = useState<string | null>(null);
  // Items 6-7: agent tasks and custom scenarios are sections like Run
  // history — a plain title plus an explicit button, and the button opens the
  // full content in a side panel. The title itself is never the button.
  const [tasksOpen, setTasksOpen] = useState(false);
  const [scenariosOpen, setScenariosOpen] = useState(false);
  const [fixesOpen, setFixesOpen] = useState(false);
  const [taskCounts, setTaskCounts] = useState<{ proposed: number; approved: number } | null>(null);
  const [scenarioCount, setScenarioCount] = useState<number | null>(null);
  const [fixCounts, setFixCounts] = useState<{ open: number; accepted: number } | null>(null);

  // Title counts load with the screen (the panels refresh them after edits),
  // so the section headers show counts before anything is opened.
  useEffect(() => {
    let live = true;
    setTaskCounts(null);
    setScenarioCount(null);
    setFixCounts(null);
    listSuggestions(projectId).then(
      (r) => {
        if (!live) return;
        setFixCounts({
          open: r.suggestions.filter((s) => s.status === 'proposed').length,
          accepted: r.suggestions.filter((s) => s.status === 'accepted').length,
        });
      },
      () => {},
    );
    listAgentTasks(projectId).then(
      (r) => {
        if (!live) return;
        setTaskCounts({
          proposed: r.tasks.filter((t) => t.status === 'proposed').length,
          approved: r.tasks.filter((t) => t.status === 'approved').length,
        });
      },
      () => {},
    );
    listProjectTools(projectId).then(
      ({ tools }) => {
        const first = tools[0];
        if (!live || !first) return;
        listEvalScenarios(projectId, first.id).then(
          ({ scenarios }) => { if (live) setScenarioCount(scenarios.length); },
          () => {},
        );
      },
      () => {},
    );
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);
  // FE-09: running an evaluation is a project mutation (enqueue + probes).
  const access = useProjectAccess();
  // Queue visibility: an eval started anywhere (another screen, another
  // tab) shows its running status here too; when it settles the runs
  // reload so the stages refresh. A run started on this screen uses the
  // local job state above, which takes precedence below.
  const queueEvals = useQueueJobs(projectId, ['eval'], () => void loadRuns());

  // Runs arrive newest-first; the "previous run" for a selection is the next
  // older entry. EV-02 compares the selected run against it.
  const selectRun = async (list: BackendEvalRun[], target: BackendEvalRun) => {
    const { run: br, results } = await getEvalRun(target.id);
    setRun(mapBackendEvalRun(br, results));
    setSelectedRun(br);
    setCurrentResults(results);
    const idx = list.findIndex((r) => r.id === target.id);
    const older = idx >= 0 ? list[idx + 1] : undefined;
    if (!older) {
      setPrevious(null);
      return;
    }
    try {
      const prev = await getEvalRun(older.id);
      setPrevious({ run: prev.run, results: prev.results });
    } catch {
      setPrevious(null);
    }
  };

  const loadRuns = async () => {
    try {
      const { runs: fresh } = await listEvalRuns(projectId);
      setRuns(fresh);
      if (fresh.length > 0) {
        await selectRun(fresh, fresh[0]);
      } else {
        setRun(null);
        setSelectedRun(null);
        setCurrentResults([]);
        setPrevious(null);
      }
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
      setRuns([]);
    }
  };

  useEffect(() => {
    setRuns(null);
    setRun(null);
    setSelectedRun(null);
    setCurrentResults([]);
    setPrevious(null);
    void loadRuns();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const startEval = async () => {
    setBusy(true);
    setJobError(null);
    try {
      const { job: enqueued, deduplicated } = await enqueueEval(projectId);
      if (deduplicated) setJobError('An evaluation is already queued or running — showing its progress.');
      const done = await pollJob(enqueued.id, setJob);
      setJob(done);
      if (done.status === 'failed') throw new Error(done.error ?? 'Evaluation job failed');
      if (done.status === 'cancelled') throw new Error('Evaluation job was cancelled');
      await loadRuns();
    } catch (e) {
      setJobError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // EV-03: one click → the server renders the report. With report storage
  // configured the answer is a signed URL (opened in a new tab); without it
  // (local dev) the HTML comes back inline and is downloaded directly —
  // no popup, so no blocker can eat the click.
  const downloadReport = async () => {
    if (!run) return;
    setReportBusy(true);
    setReportError(null);
    try {
      const { report } = await getEvalReport(projectId, run.id);
      if (report.inline && typeof report.html === 'string') {
        const blob = new Blob([report.html], { type: 'text/html' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `eval-report-${report.run_id}.html`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 5000);
      } else if (report.url) {
        window.open(report.url, '_blank', 'noopener');
      } else {
        throw new Error('Report has no download — please try again');
      }
    } catch (e) {
      setReportError(e instanceof Error ? e.message : String(e));
    } finally {
      setReportBusy(false);
    }
  };

  // EV-02: selected run vs the next older run, computed once for both the
  // changes panel and the matrix highlighting.
  const diff = run && previous ? diffEvalResults(previous.results, currentResults) : null;
  const panelIdx = runs?.findIndex((r) => r.id === panelRunId) ?? -1;
  const panelRun = panelIdx >= 0 && runs ? runs[panelIdx] : null;
  const panelPrevious = panelIdx >= 0 && runs ? (runs[panelIdx + 1] ?? null) : null;
  // A run started on this screen reports through the local job; otherwise
  // show the queue's active eval (started anywhere) in the same slot.
  const shownJob = job ?? queueEvals[0] ?? null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="page-title">Evaluation</h1>
          <p className="page-sub">
            Sandbox proof that the connector behaves — not just that files were generated. Runs for{' '}
            <span className="text-slate-200 font-medium">{projectName}</span> execute on the background queue.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {run && (
            <button
              type="button"
              onClick={() => downloadReport().catch(() => {})}
              disabled={reportBusy}
              className={cn('btn btn-secondary', reportBusy && 'opacity-60')}
            >
              <Download className="h-4 w-4" />
              {reportBusy ? 'Preparing…' : 'Download report'}
            </button>
          )}
          <button
            type="button"
            onClick={() => startEval().catch(() => {})}
            disabled={busy || !access.canEdit}
            title={access.readOnlyReason ?? undefined}
            className={cn(
              'btn',
              busy || !access.canEdit ? 'bg-white/10 text-slate-500' : 'bg-neon text-ink-950 font-semibold border border-neon hover:bg-orange-300',
            )}
          >
            <FlaskConical className="h-4 w-4" />
            {busy ? 'Running…' : run ? 'Re-run evaluation' : 'Run evaluation'}
          </button>
        </div>
      </div>

      <ReadOnlyBanner reason={access.readOnlyReason} />

      {shownJob && <JobProgress job={shownJob} />}

      {jobError && (
        <div className="card-pad border-l-4 border-l-red-400">
          <p className="text-sm text-red-300">{jobError}</p>
        </div>
      )}

      <section className="card-pad">
        <SectionHeader
          title={taskCounts ? `Agent tasks (${taskCounts.approved + taskCounts.proposed})` : 'Agent tasks'}
          sub={taskCounts
            ? `${taskCounts.approved} approved · ${taskCounts.proposed} proposed — approved tasks run on every evaluation.`
            : 'Requests an AI agent completes with these tools on every evaluation — approved tasks run on every run.'}
          action={
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setTasksOpen(true)}>
              Show tasks
            </button>
          }
        />
      </section>
      {tasksOpen && (
        <SidePanel
          title="Agent tasks"
          sub="Propose tasks from your tools, or write the requests your users make — approved tasks run on every evaluation."
          onClose={() => setTasksOpen(false)}
        >
          <AgentTasksPanel projectId={projectId} canEdit={access.canEdit} bare onCounts={setTaskCounts} />
        </SidePanel>
      )}

      <section className="card-pad">
        <SectionHeader
          title={scenarioCount === null ? 'Custom scenarios' : `Custom scenarios (${scenarioCount})`}
          sub="Your own edge cases (given args → expect shape/status) — enabled scenarios run in every evaluation."
          action={
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setScenariosOpen(true)}>
              Show scenarios
            </button>
          }
        />
      </section>
      {scenariosOpen && (
        <SidePanel
          title={scenarioCount === null ? 'Custom scenarios' : `Custom scenarios (${scenarioCount})`}
          sub="Your own edge cases (given args → expect shape/status) — enabled scenarios run in every evaluation."
          onClose={() => setScenariosOpen(false)}
        >
          <CustomScenariosPanel projectId={projectId} canEdit={access.canEdit} bare onCounts={setScenarioCount} />
        </SidePanel>
      )}

      {reportError && (
        <div className="card-pad border-l-4 border-l-red-400">
          <p className="text-sm text-red-300">Could not prepare the report: {reportError}</p>
        </div>
      )}

      {loadError && (
        <ErrorState
          message={`Could not load evaluation runs: ${loadError}`}
          onRetry={() => void loadRuns()}
        />
      )}

      {runs === null ? (
        <LoadingState label="Loading evaluation runs…" />
      ) : runs.length === 0 && !run && !loadError ? (
        <EmptyState
          title="No evaluation runs yet"
          sub="Compile tools first, then run an evaluation to get live sandbox proof for this project."
          action={
            <button
              type="button"
              onClick={() => startEval().catch(() => {})}
              disabled={busy || !access.canEdit}
              title={access.readOnlyReason ?? undefined}
              className="btn-primary btn-sm disabled:opacity-40"
            >
              <FlaskConical className="h-4 w-4" />
              {busy ? 'Running…' : 'Run evaluation'}
            </button>
          }
        />
      ) : (
        <Fragment>
          {runs.length > 1 && (
            <section className="card-pad">
              <SectionHeader title="Run history" sub="Newest first. Opening a run shows its details in a side panel — the screen below stays on the latest run." />
              <div className="space-y-2">
                {runs.map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => setPanelRunId(r.id)}
                    className="w-full flex items-center justify-between gap-3 rounded-lg border border-white/10 px-3 py-2 hover:bg-white/5 text-left"
                  >
                    <span className="mono text-xs text-slate-300">{r.id.slice(0, 8)}</span>
                    <span className="text-xs text-slate-500">{formatRunDateTime(r.started_at)}</span>
                    <span className="inline-flex items-center gap-2">
                      {r.summary?.certification?.certified && (
                        <Badge tone="green">
                          <span className="inline-flex items-center gap-1">
                            <ShieldCheck className="h-3.5 w-3.5" />
                            Certified
                          </span>
                        </Badge>
                      )}
                      <Badge tone={r.status === 'passed' ? 'green' : r.status === 'failed' ? 'red' : 'blue'}>
                        {r.status}
                      </Badge>
                    </span>
                  </button>
                ))}
              </div>
            </section>
          )}
          {run && previous && diff && <EvalDiffPanel diff={diff} previousRun={previous.run} />}
          {run && !previous && runs.length === 1 && (
            <section className="card-pad">
              <p className="text-sm text-slate-400">
                This is the first evaluation run for this project — re-run the evaluation to see what changed versus
                this run.
              </p>
            </section>
          )}
          {selectedRun?.summary?.certification && (
            <CertificationPanel cert={selectedRun.summary.certification} />
          )}
          {selectedRun && (
            <AgentComparisonPanel projectId={projectId} run={selectedRun} previous={previous?.run ?? null} />
          )}
          {run && (
            <section className="card-pad">
              <SectionHeader
                title={fixCounts ? `Suggested fixes (${fixCounts.open + fixCounts.accepted})` : 'Suggested fixes'}
                sub={fixCounts && fixCounts.accepted > 0
                  ? `${fixCounts.open} proposed · ${fixCounts.accepted} accepted — nothing applies until you accept it.`
                  : 'Edits to what agents read, proposed from review findings and failures. Nothing applies until you accept it.'}
                action={
                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => setFixesOpen(true)}>
                    Show fixes
                  </button>
                }
              />
            </section>
          )}
          {run && fixesOpen && (
            <SidePanel
              title={fixCounts ? `Suggested fixes (${fixCounts.open + fixCounts.accepted})` : 'Suggested fixes'}
              sub="Edits to what agents read, proposed from review findings, failed scenarios and failed agent tasks. Nothing applies until you accept it."
              onClose={() => setFixesOpen(false)}
            >
              <SuggestionsPanel projectId={projectId} canEdit={access.canEdit} bare onCounts={setFixCounts} />
            </SidePanel>
          )}
          {run && <RunDetail run={run} highlightKeys={diff ? newFailureKeys(diff) : undefined} projectId={projectId} canEdit={access.canEdit} evalRunning={!!shownJob && isJobActive(shownJob)} />}
        </Fragment>
      )}
      {panelRun && (
        <RunSidePanel runMeta={panelRun} previousMeta={panelPrevious} onClose={() => setPanelRunId(null)} />
      )}
    </div>
  );
}

export default function EvaluatePage() {
  const activeProject = useActiveProject();
  if (!activeProject) return <NoProject />;
  return <RealEvaluate projectId={activeProject.id} projectName={activeProject.name} />;
}
