import { useEffect } from 'react';
import { Badge, EmptyState, ErrorState, SectionHeader, StatCard } from '../../shared/components/atoms';
import NoProject from '../../shared/components/NoProject';
import { useActiveProject, useFoundryStore, useProjectAccess } from '../../app/store';
import { planForMe } from '../../data/plan';
import { cn } from '../../shared/lib/utils';
import GatewayKeysPanel from './GatewayKeysPanel';
import DriftSection from './DriftSection';
import AttributionSection, { TriggerCell } from './AttributionSection';

// Operate = what the data plane actually recorded for the active project
// (GET /v1/projects/:id/telemetry), its gateway keys and its drift probes.
// D-87: no synthetic data — every panel reads what the backend recorded.
// D-89: call attribution (trigger, client, channel, release, shared prompts)
// is recorded by the data plane; fix suggestions live on Evaluate (HK-09).

const lookbackLabel = (days: number) =>
  days >= 365 ? '12-month lookback' : `${Math.round(days / 30)}-month lookback`;

export default function OperatePage() {
  const project = useActiveProject();
  const me = useFoundryStore((s) => s.me);
  const plan = planForMe(me);
  const telemetry = useFoundryStore((s) => s.telemetry);
  const access = useProjectAccess();
  const error = useFoundryStore((s) => s.error);
  const loadTelemetry = useFoundryStore((s) => s.loadTelemetry);
  const projectId = project?.id;

  useEffect(() => {
    if (projectId) loadTelemetry().catch(() => {});
  }, [projectId, loadTelemetry]);

  if (!project) return <NoProject />;

  const calls = telemetry?.by_tool.reduce((s, t) => s + t.calls, 0) ?? 0;
  const ok = telemetry?.by_tool.reduce((s, t) => s + t.ok_calls, 0) ?? 0;
  const tools = telemetry?.by_tool ?? [];
  const avgMs = tools.length ? Math.round(tools.reduce((s, t) => s + t.avg_ms, 0) / tools.length) : 0;
  const maxToolCalls = Math.max(...tools.map((t) => t.calls), 1);

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center justify-between gap-4">
          <h1 className="page-title">Operate</h1>
          {plan && <Badge tone="blue">{plan.planName} · {lookbackLabel(plan.retentionDays)}</Badge>}
        </div>
        <p className="page-sub">Data-plane telemetry for {project.name} — calls to its pinned releases.</p>
      </div>

      {/* FE-05: a failed load explains itself with a retry. */}
      {error && !telemetry && (
        <ErrorState
          message={`Could not load invocations: ${error}`}
          onRetry={() => loadTelemetry().catch(() => {})}
        />
      )}

      {telemetry && (
        <div className="card-pad">
          <SectionHeader
            title="Invocations"
            sub="Real data-plane calls (pinned releases only)."
            action={
              <button type="button" onClick={() => loadTelemetry().catch(() => {})} className="btn btn-sm btn-secondary">
                Refresh
              </button>
            }
          />
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-5">
            <StatCard label="Calls" value={String(calls)} />
            <StatCard label="Success rate" value={calls ? `${Math.round((ok / calls) * 100)}%` : '—'} />
            <StatCard label="Avg latency" value={`${avgMs}ms`} />
            <StatCard label="Tools called" value={String(tools.length)} />
          </div>

          {tools.length > 0 && (
            <div className="mb-6">
              <h3 className="text-sm font-medium text-slate-200 mb-3">Calls per tool</h3>
              <div className="space-y-2.5">
                {tools.map((t) => (
                  <div key={t.tool_name}>
                    <div className="flex items-center justify-between text-xs mb-1">
                      <span className="mono text-slate-300">{t.tool_name}</span>
                      <span className="text-slate-500">
                        {t.calls.toLocaleString()} calls · {t.calls ? Math.round((t.ok_calls / t.calls) * 100) : 0}% ok
                      </span>
                    </div>
                    <div className="h-2 rounded-full bg-white/5 overflow-hidden">
                      <div
                        className={cn('h-full rounded-full', t.calls === 0 ? 'bg-white/20' : 'bg-neon/70')}
                        style={{ width: `${Math.max((t.calls / maxToolCalls) * 100, 2)}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {telemetry.recent.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-slate-500 border-b border-white/10">
                    <th className="py-2 pr-4 font-medium">Tool</th>
                    <th className="py-2 pr-4 font-medium">Trigger</th>
                    <th className="py-2 pr-4 font-medium">Client</th>
                    <th className="py-2 pr-4 font-medium">Prompt</th>
                    <th className="py-2 pr-4 font-medium">Release</th>
                    <th className="py-2 pr-4 font-medium">Status</th>
                    <th className="py-2 pr-4 font-medium">Latency</th>
                    <th className="py-2 font-medium">Time</th>
                  </tr>
                </thead>
                <tbody>
                  {telemetry.recent.slice(0, 10).map((r, i) => (
                    <tr key={i} className="border-b border-white/5">
                      <td className="py-2 pr-4 mono">{r.tool_name}</td>
                      <td className="py-2 pr-4"><TriggerCell trigger={r.trigger} source={r.trigger_source} /></td>
                      <td className="py-2 pr-4 text-slate-300">{r.client ?? '—'}</td>
                      <td className="py-2 pr-4 text-slate-400 max-w-[16rem] truncate" title={r.prompt_text ?? undefined}>
                        {r.prompt_text ?? <span className="text-slate-600">not shared</span>}
                      </td>
                      <td className="py-2 pr-4 mono text-slate-400">{r.release_version ?? '—'}</td>
                      <td className="py-2 pr-4">
                        <Badge tone={r.status === 'ok' ? 'green' : 'red'}>{r.status}</Badge>
                      </td>
                      <td className="py-2 pr-4 mono">{r.latency_ms}ms</td>
                      <td className="py-2 text-slate-400">{new Date(r.created_at).toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState title="No invocations yet" sub="Invoke a tool through the data plane to see telemetry here." />
          )}
        </div>
      )}

      {telemetry && (
        <AttributionSection
          projectId={project.id}
          telemetry={telemetry}
          canEdit={access.canEdit}
          onChanged={() => loadTelemetry().catch(() => {})}
        />
      )}

      {/* DP-07: gateway API keys for script/agent-client invokes (Run plane). */}
      <GatewayKeysPanel />

      <DriftSection />
    </div>
  );
}
