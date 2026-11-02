import { Fragment, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowRight,
  Check,
  ClipboardList,
  Download,
  FlaskConical,
  Rocket,
  Sparkles,
  Wrench,
  X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useActiveProject, useFoundryStore } from '../../app/store';
import { formatTargets } from '../../data/projects';
import type { ProjectSummary } from '../../data/projects';
import {
  fetchEvalSummary,
  getProject,
  listJobs,
  listReleases,
  listReviewItems,
  type DashboardReviewItem,
  type EvalSummary,
  type Job,
  type ReleaseSummary,
} from '../../data/api';
import NoProject from '../../shared/components/NoProject';
import { Badge, EmptyState, ErrorState, KpiCard, LoadingState, ProgressBar, SectionHeader, Ticker } from '../../shared/components/atoms';
import { cn } from '../../shared/lib/utils';

// ─── Pipeline stepper ────────────────────────────────────────────────────────

type StageStatus = 'done' | 'active' | 'blocked';

const circleClass: Record<StageStatus, string> = {
  done: 'bg-emerald-400/15 border border-emerald-400/40 text-emerald-300',
  active: 'bg-neon/15 border border-neon/40 text-neon shadow-glow',
  blocked: 'bg-red-400/15 border border-red-400/40 text-red-300',
};

const lineClass: Record<StageStatus, string> = {
  done: 'bg-emerald-400/30',
  active: 'bg-neon/25',
  blocked: 'bg-red-400/30',
};

const statusLabel: Record<StageStatus, string> = {
  done: 'Done',
  active: 'In progress',
  blocked: 'Blocked',
};

const statusTextClass: Record<StageStatus, string> = {
  done: 'text-emerald-300',
  active: 'text-neon',
  blocked: 'text-red-300',
};


// ─── AI briefing ─────────────────────────────────────────────────────────────

function AiBriefing({ insights }: { insights: string[] }) {
  const [index, setIndex] = useState(0);
  const [minimized, setMinimized] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  if (dismissed) return null;

  if (minimized) {
    return (
      <button
        onClick={() => setMinimized(false)}
        className="fixed bottom-6 right-6 z-30 flex items-center gap-2 px-4 py-2.5 rounded-full bg-ink-800 border border-neon/30 text-neon text-sm font-medium shadow-glow hover:bg-ink-700 transition-colors"
      >
        <Sparkles size={16} />
        Foundry briefing
      </button>
    );
  }

  return (
    <div className="card panel-glow p-5 max-w-[calc(100vw-3rem)] sm:max-w-sm">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="font-semibold text-white text-sm">Foundry Copilot</div>
          <div className="micro-label mt-1">Release signals · AI briefing</div>
        </div>
        <span className="mono text-slate-500 text-xs shrink-0">
          {index + 1} / {insights.length}
        </span>
      </div>
      <p className="text-sm text-slate-300 mt-3 leading-relaxed">{insights[index]}</p>
      <div className="flex gap-2 mt-4">
        <button
          onClick={() => setIndex((index + 1) % insights.length)}
          className="btn-primary btn-sm"
        >
          Next
        </button>
        <button onClick={() => setMinimized(true)} className="btn-secondary btn-sm">
          Minimize
        </button>
        <button onClick={() => setDismissed(true)} className="btn-ghost btn-sm">
          Dismiss
        </button>
      </div>
    </div>
  );
}

// ─── Real project dashboard ────────────────────────────────────────────────
// Command center for a project: pipeline state, findings, and eval results
// all come from the API.

type RealStageStatus = 'done' | 'active' | 'blocked' | 'todo';

const realCircleClass: Record<RealStageStatus, string> = {
  ...circleClass,
  todo: 'bg-white/5 border border-white/15 text-slate-500',
};
const realLineClass: Record<RealStageStatus, string> = {
  ...lineClass,
  todo: 'bg-white/10',
};
const realStatusLabel: Record<RealStageStatus, string> = {
  ...statusLabel,
  todo: 'Not started',
};
const realStatusTextClass: Record<RealStageStatus, string> = {
  ...statusTextClass,
  todo: 'text-slate-500',
};

const findingTone: Record<string, 'red' | 'amber' | 'blue' | 'purple' | 'gray'> = {
  risk: 'red',
  ambiguity: 'amber',
  coverage: 'blue',
  contract: 'purple',
};

function RealProjectDashboard({ project }: { project: ProjectSummary }) {
  const [live, setLive] = useState<ProjectSummary | null>(null);
  const [evalSummary, setEvalSummary] = useState<EvalSummary | null>(null);
  const [findings, setFindings] = useState<DashboardReviewItem[] | null>(null);
  const [releases, setReleases] = useState<ReleaseSummary[] | null>(null);
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // FE-05: a failed load explains itself and offers this retry, which
  // re-runs the fetch by bumping the effect key below.
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [p, e, { review_items: f }, { releases: r }, { jobs: j }] = await Promise.all([
          getProject(project.id),
          fetchEvalSummary(project.id),
          listReviewItems(project.id),
          listReleases(project.id),
          listJobs(project.id, 5),
        ]);
        if (cancelled) return;
        setLive(p);
        setEvalSummary(e);
        setFindings(f);
        setReleases(r);
        setJobs(j);
        setError(null);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => { cancelled = true; };
  }, [project.id, reloadKey]);

  const p = live ?? project;
  const openFindings = (findings ?? []).filter((f) => f.status === 'open');
  const opsCount = p.operationsCount ?? 0;
  const jobRunning = (jobs ?? []).some((j) => j.status === 'queued' || j.status === 'running');
  const publishing = useFoundryStore((s) => s.publishing);

  const currentStage =
    releases && releases.length > 0 ? 'Published'
    : evalSummary ? 'Evaluated'
    : p.toolsTotal > 0 ? 'In review'
    : opsCount > 0 ? 'Compiling'
    : 'Importing';

  const stages: { label: string; icon: LucideIcon; status: RealStageStatus }[] = [
    { label: 'Import', icon: Download, status: opsCount > 0 ? 'done' : 'todo' },
    { label: 'Compile', icon: Wrench, status: p.toolsTotal > 0 ? 'done' : opsCount > 0 ? 'active' : 'todo' },
    {
      label: 'Review', icon: ClipboardList,
      status: openFindings.length > 0 ? 'active' : p.toolsTotal > 0 ? 'done' : 'todo',
    },
    {
      label: 'Evaluate', icon: FlaskConical,
      status: jobRunning ? 'active' : evalSummary ? (evalSummary.passRate >= 70 ? 'done' : 'active') : p.toolsTotal > 0 ? 'active' : 'todo',
    },
    {
      label: 'Publish', icon: Rocket,
      status: releases && releases.length > 0 ? 'done'
        : openFindings.length > 0 ? 'blocked'
        : evalSummary && evalSummary.passRate >= 70 ? 'active' : 'todo',
    },
  ];

  const evalTone = !evalSummary ? 'gray' : evalSummary.passRate >= 90 ? 'green' : evalSummary.passRate >= 70 ? 'amber' : 'red';

  const insights = [
    openFindings.length > 0
      ? `${openFindings.length} open finding${openFindings.length === 1 ? '' : 's'} need${openFindings.length === 1 ? 's' : ''} your review before ${p.name} can ship — top of the list: “${openFindings[0]?.title}”.`
      : `No open findings for ${p.name} — the review queue is clear.`,
    evalSummary
      ? `Latest eval run: ${evalSummary.passRate}% pass rate (${evalSummary.passCount} of ${evalSummary.scenarioCount} scenarios), status ${evalSummary.status}.`
      : `No evaluation run yet for ${p.name} — run one from the Evaluate screen to get live sandbox proof.`,
    `${p.toolsApproved} of ${p.toolsTotal} proposed tools approved for ${formatTargets(p.targets)}.`,
    `Pipeline stage: ${currentStage}. ${releases && releases.length > 0 ? `${releases.length} release${releases.length === 1 ? '' : 's'} cut.` : 'No releases cut yet.'}`,
  ];

  const tickerItems = [
    `${p.toolsApproved} OF ${p.toolsTotal} TOOLS APPROVED`,
    evalSummary ? `EVAL PASS RATE ${evalSummary.passRate}% · ${evalSummary.passCount}/${evalSummary.scenarioCount} SCENARIOS` : 'EVAL NOT RUN YET',
    `${openFindings.length} FINDINGS OPEN`,
    `${(releases ?? []).length} RELEASES`,
    `${p.name.toUpperCase()} · ${currentStage.toUpperCase()}`,
  ];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-6 flex-wrap">
        <div>
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="page-title">{p.name} command center</h1>
            <Badge tone="green">live</Badge>
          </div>
          <p className="page-sub">
            {p.name} → {formatTargets(p.targets)} · {p.blurb}
          </p>
        </div>
        <AiBriefing insights={insights} />
      </div>

      {error && (
        <ErrorState
          message={`Could not load live dashboard data: ${error}`}
          hint="Showing the registry snapshot below in the meantime."
          onRetry={() => setReloadKey((k) => k + 1)}
        />
      )}

      {/* Jump pills */}
      <div className="flex gap-2 flex-wrap">
        {[
          { label: 'Pipeline', target: 'section-pipeline' },
          { label: 'Findings', target: 'section-findings' },
          { label: 'Evaluate', target: 'section-eval' },
        ].map((t) => (
          <button
            key={t.target}
            onClick={() => document.getElementById(t.target)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
            className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full border border-white/15 bg-white/5 text-xs font-semibold uppercase tracking-[0.14em] text-slate-300 hover:border-neon/40 hover:text-neon transition-colors"
          >
            <span className="w-1.5 h-1.5 rotate-45 bg-neon/70" />
            {t.label}
          </button>
        ))}
      </div>

      {/* Ticker */}
      <div className="-mx-4 sm:-mx-6 xl:-mx-8">
        <Ticker items={tickerItems} />
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-1 min-[420px]:grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard
          tag="Tools"
          accent="orange"
          label="Tools approved"
          value={`${p.toolsApproved} of ${p.toolsTotal}`}
          sub={`${p.toolsTotal - p.toolsApproved} awaiting review`}
        />
        <KpiCard
          tag="Eval"
          accent="green"
          label="Eval pass rate"
          value={evalSummary ? `${evalSummary.passRate}%` : '—'}
          sub={evalSummary ? `${evalSummary.passCount} of ${evalSummary.scenarioCount} scenarios` : 'No runs yet'}
        />
        <KpiCard
          tag="Findings"
          accent="red"
          label="Open findings"
          value={`${openFindings.length}`}
          sub={findings === null ? 'Loading…' : 'from import analysis'}
        />
        <KpiCard
          tag="Pipeline"
          accent="amber"
          label="Current stage"
          value={currentStage}
          sub={`${opsCount} operations imported`}
        />
      </div>

      <div className="neon-line" />

      {/* Pipeline — full width, first: where the project stands */}
      <div id="section-pipeline" className="card-pad panel-glow scroll-mt-24">
        <SectionHeader index="01 · Pipeline" title="Release pipeline" hint="LIVE PROJECT STATE" />
        <div className="flex items-start pt-1">
          {stages.map((stage, i) => (
            <Fragment key={stage.label}>
              <div className="flex flex-col items-center shrink-0 w-16 sm:w-20">
                <span className={cn('w-10 h-10 rounded-full flex items-center justify-center', realCircleClass[stage.status])}>
                  {stage.status === 'done' ? (
                    <Check size={18} />
                  ) : stage.status === 'blocked' ? (
                    <X size={18} />
                  ) : (
                    <stage.icon size={18} />
                  )}
                </span>
                <span className="text-xs font-medium text-slate-300 mt-2 text-center">{stage.label}</span>
                <span className={cn('text-[11px] mt-0.5 font-mono', realStatusTextClass[stage.status])}>{realStatusLabel[stage.status]}</span>
              </div>
              {i < stages.length - 1 && <div className={cn('flex-1 h-0.5 mt-5', realLineClass[stage.status])} />}
            </Fragment>
          ))}
        </div>
        {jobRunning && (
          <p className="mt-4 text-sm text-amber-300">
            A {(jobs ?? []).find((j) => j.status === 'queued' || j.status === 'running')?.kind} job is running on the queue — stages refresh when it finishes.
          </p>
        )}
        {publishing && (
          <p className="mt-4 text-sm text-amber-300">
            A release is publishing — stages refresh when it finishes.
          </p>
        )}
      </div>

      {/* Findings + latest eval run */}
      <div className="grid lg:grid-cols-2 gap-6">
        {/* Findings showcase — counts by kind only; the full list lives on
            the API Source screen and decisions happen in the review queue. */}
        <div id="section-findings" className="scroll-mt-24">
        <SectionHeader index="02 · Findings" title="Findings" hint="IMPORT ANALYSIS · LIVE FROM THE DATABASE" />
        {findings === null ? (
          <LoadingState label="Loading findings…" />
        ) : openFindings.length === 0 ? (
          <EmptyState title="No open findings" sub="Import analysis is clean — nothing needs your review right now." />
        ) : (
          <div className="card panel-glow">
            <div className="divide-y divide-white/10">
              {Object.entries(
                openFindings.reduce<Record<string, number>>((acc, f) => {
                  acc[f.kind] = (acc[f.kind] ?? 0) + 1;
                  return acc;
                }, {}),
              )
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([kind, n]) => (
                  <div key={kind} className="flex items-center gap-3 px-5 py-3.5">
                    <Badge tone={findingTone[kind] ?? 'gray'}>{kind}</Badge>
                    <span className="flex-1 text-sm text-slate-200">
                      {n} open finding{n === 1 ? '' : 's'}
                    </span>
                    <span className="mono text-sm text-slate-100">{n}</span>
                  </div>
                ))}
            </div>
            <div className="flex flex-wrap gap-2 px-5 py-4 border-t border-white/10">
              <Link to="/import" className="btn btn-secondary btn-sm">
                See all findings on API Source <ArrowRight size={14} />
              </Link>
              <Link to="/review" className="btn btn-secondary btn-sm">
                Decide in review queue <ArrowRight size={14} />
              </Link>
            </div>
          </div>
        )}
      </div>

        <div id="section-eval" className="card-pad panel-glow scroll-mt-24">
          <SectionHeader index="03 · Evaluate" title="Latest eval run" hint="CLICK THROUGH FOR FAILURE TRACES" />
          {!evalSummary ? (
            <EmptyState
              title="No evaluation runs yet"
              sub="Run an evaluation to get live sandbox proof for this project."
              action={
                <Link to="/evaluate" className="btn-secondary btn-sm">
                  Run an evaluation
                </Link>
              }
            />
          ) : (
            <Fragment>
              <div className="mono text-slate-500 mb-4 text-sm">
                {evalSummary.runId.slice(0, 8)} · {evalSummary.finishedAt ? new Date(evalSummary.finishedAt).toLocaleString() : 'running'}
              </div>
              <div className="flex items-center justify-between text-sm mb-2">
                <span className="font-medium text-slate-300">Overall pass rate</span>
                <span className="mono text-slate-100">
                  {evalSummary.passCount}/{evalSummary.scenarioCount} · {evalSummary.passRate}%
                </span>
              </div>
              <ProgressBar value={evalSummary.passRate} tone={evalTone === 'gray' ? 'brand' : evalTone} />
              <div className="mt-3">
                <Badge tone={evalSummary.status === 'passed' ? 'green' : evalSummary.status === 'failed' ? 'red' : 'blue'}>
                  {evalSummary.status}
                </Badge>
              </div>
            </Fragment>
          )}
        </div>
      </div>

      {/* CTA row */}
      <div className="flex flex-wrap gap-3">
        <Link to="/review" className="btn-primary">
          Open review queue <ArrowRight size={16} />
        </Link>
        <Link to="/evaluate" className="btn-secondary">
          View eval results
        </Link>
      </div>
    </div>
  );
}

// ─── Dashboard entry ─────────────────────────────────────────────────────────

export default function DashboardPage() {
  const project = useActiveProject();
  if (!project) return <NoProject />;
  return <RealProjectDashboard project={project} />;
}
