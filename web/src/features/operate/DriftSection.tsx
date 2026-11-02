// Drift alerts section (TE-03) — Run plane (Operate).
//
// Live drift data: scheduled contract probes
// against the prod release's frozen tools open an alert per tool whose
// contract breaks, and the next passing check auto-resolves it. Viewers
// see the list read-only; owner/editor can trigger a manual check
// (FE-09: the button is convenience — POST /drift/check is the real gate).
import { useCallback, useEffect, useState } from 'react';
import {
  listDriftAlerts, listDriftChecks, triggerDriftCheck,
  type DriftAlertRow, type DriftCheckRow,
} from '../../data/api';
import { useFoundryStore } from '../../app/store';
import { Badge, EmptyState, ErrorState, LoadingState, SectionHeader } from '../../shared/components/atoms';
import {
  alertFailingLabels, canTriggerDriftCheck, driftCheckSummaryLine, timeAgo,
} from './drift';

export default function DriftSection() {
  const liveProjectId = useFoundryStore((s) => s.activeProjectId);

  const [alerts, setAlerts] = useState<DriftAlertRow[] | null>(null);
  const [checks, setChecks] = useState<DriftCheckRow[] | null>(null);
  const [callerRole, setCallerRole] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!liveProjectId) return;
    setError(null);
    try {
      const [a, c] = await Promise.all([
        listDriftAlerts(liveProjectId),
        listDriftChecks(liveProjectId),
      ]);
      setAlerts(a.alerts);
      setChecks(c.checks);
      setCallerRole(a.caller_role);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [liveProjectId]);

  useEffect(() => {
    if (liveProjectId) {
      setAlerts(null);
      setChecks(null);
      load().catch(() => {});
    }
  }, [liveProjectId, load]);

  if (!liveProjectId) return null;

  const runNow = async () => {
    setBusy(true);
    setError(null);
    try {
      await triggerDriftCheck(liveProjectId);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const latest: DriftCheckRow | null = checks?.[0] ?? null;
  const manage = canTriggerDriftCheck(callerRole);
  const lastCheckLine = latest
    ? `Last check ${timeAgo(latest.started_at)} · ${driftCheckSummaryLine(latest)}`
    : 'No drift checks have run yet for the prod release.';

  return (
    <div className="card-pad">
      <SectionHeader index="06 · Drift" title="Drift alerts" sub="Source API changes that affect the connector" />
      {error && alerts === null ? (
        <ErrorState message="Couldn't load drift alerts." hint={error} onRetry={load} />
      ) : alerts === null ? (
        <LoadingState label="Loading drift alerts…" />
      ) : alerts.length === 0 ? (
        <EmptyState
          title="No drift detected"
          sub={lastCheckLine}
          action={manage ? (
            <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={runNow}>
              {busy ? 'Checking…' : 'Run check now'}
            </button>
          ) : undefined}
        />
      ) : (
        <ul className="divide-y divide-white/10">
          {alerts.map((alert) => (
            <li key={alert.id} className="py-4 first:pt-0 last:pb-0">
              <div className="flex items-start justify-between gap-3">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <Badge tone="red">drift</Badge>
                    <span className="font-medium text-slate-100">{alert.tool_name}</span>
                  </div>
                  <p className="text-sm text-slate-400">
                    Contract failing: {alertFailingLabels(alert).join(', ') || 'see evidence'}
                  </p>
                  <p className="text-xs text-slate-500">
                    First seen {timeAgo(alert.first_seen_at)} · last seen {timeAgo(alert.last_seen_at)}
                  </p>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
      {/* FE-05: failures over held data stay inline with a retry. */}
      {error && alerts !== null && (
        <p className="mt-3 text-xs text-red-300" role="alert">
          {error}{' '}
          <button type="button" className="underline" onClick={load}>Retry</button>
        </p>
      )}
      <div className="mt-4 flex items-center justify-between gap-3 border-t border-white/10 pt-3">
        <p className="text-xs text-slate-500">{lastCheckLine}</p>
        {manage ? (
          <button
            type="button"
            className="btn btn-secondary btn-sm shrink-0"
            disabled={busy}
            onClick={runNow}
            title="Run the contract probes against the prod release now"
          >
            {busy ? 'Checking…' : 'Run check now'}
          </button>
        ) : (
          <span className="text-xs text-slate-500 shrink-0" title="Viewers can't trigger drift checks">
            Run check now (owner/editor)
          </span>
        )}
      </div>
    </div>
  );
}
