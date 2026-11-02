import { useEffect, useState } from 'react';
import { CheckCircle2, Circle, XCircle } from 'lucide-react';
import { useActiveProject, useFoundryStore, useReadiness, useProjectAccess } from '../../app/store';
import NoProject from '../../shared/components/NoProject';
import ReadOnlyBanner from '../../shared/components/ReadOnlyBanner';
import JobProgress from '../../shared/components/JobProgress';
import { useQueueJobs } from '../../data/queueJobs';
import { downloadManifest, downloadStdioBridge, downloadOpenAiTools, downloadGptActionsSpec, downloadMuseKit, getMuseKit, getPromotionReadiness, listReleases, API_BASE, type MuseKitSummary, type PromotionReadiness, type ReleaseSummary } from '../../data/api';
import { mcpEndpointUrl, mcpServerName, mcpClientConfig } from './mcpConfig';
import { readinessPanelStatus } from './promotionReadiness';
import { gptActionsSetup, gptActionsSpecUrl } from './openaiConfig';
import { ReleaseInsights } from './ReleasePanels';
import { Badge, KvRow, ProgressBar, SectionHeader } from '../../shared/components/atoms';

interface ChecklistItem {
  label: string;
  done: boolean;
  detail: string;
}

/** Every release of the project, newest first (GET /v1/projects/:id/releases). */
function VersionHistory({ projectId, latestId }: { projectId: string; latestId: string | undefined }) {
  const [rows, setRows] = useState<ReleaseSummary[] | null>(null);
  useEffect(() => {
    let live = true;
    listReleases(projectId)
      .then(({ releases }) => { if (live) setRows(releases); })
      .catch(() => { if (live) setRows([]); });
    return () => { live = false; };
  }, [projectId, latestId]);
  return (
    <div className="card-pad">
      <SectionHeader title="Version history" />
      {!rows ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-slate-400">No releases yet.</p>
      ) : (
        <ul className="divide-y divide-white/10">
          {rows.map((v) => (
            <li key={v.id} className="flex items-center justify-between gap-4 py-3">
              <div className="flex items-center gap-3">
                <Badge tone="blue">{v.version}</Badge>
                <Badge tone={v.channel === 'prod' ? 'green' : 'gray'}>{v.channel ?? v.status}</Badge>
              </div>
              <span className="mono text-sm text-slate-400">{new Date(v.created_at).toLocaleDateString()}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** HK-08: Muse submission kit for the live release. Muse has no manifest
 *  spec — intake is a manual form pointed at our hosted MCP endpoint
 *  (RL-02) — so this card shows the endpoint, the review gate result and
 *  the kit download. A blocked gate names the reason per tool. */
function MuseCard({ releaseId }: { releaseId: string }) {
  const [kit, setKit] = useState<MuseKitSummary | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    getMuseKit(releaseId)
      .then((k) => { if (live) setKit(k); })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [releaseId]);
  return (
    <div className="card-pad">
      <SectionHeader
        title="Meta Muse connector"
        sub="Submission kit for the manual Muse intake form — our hosted MCP endpoint plus per-tool access classes and the review gate."
      />
      {!kit ? (
        <p className="text-sm text-slate-500">{failed ? 'Could not load the Muse kit.' : 'Loading…'}</p>
      ) : (
        <>
          <dl>
            <KvRow k="Endpoint"><span className="mono text-xs break-all">{kit.connection.mcp_endpoint}</span></KvRow>
            <KvRow k="Tools">
              <span className="text-sm text-slate-300">
                {kit.tools.length} evaluated tools (
                {kit.tools.filter((t) => t.access_class === 'read').length} read ·{' '}
                {kit.tools.filter((t) => t.access_class === 'write').length} write ·{' '}
                {kit.tools.filter((t) => t.access_class === 'sensitive_write').length} sensitive-write)
              </span>
            </KvRow>
            <KvRow k="Review gate">
              {kit.review_gate.eligible ? (
                <Badge tone="green">Eligible — no money movement, no unconfirmed writes</Badge>
              ) : (
                <Badge tone="red">Blocked — {kit.review_gate.reasons.length} reason{kit.review_gate.reasons.length === 1 ? '' : 's'}</Badge>
              )}
            </KvRow>
          </dl>
          {!kit.review_gate.eligible && (
            <ul className="mt-3 space-y-1.5">
              {kit.review_gate.reasons.map((r) => (
                <li key={`${r.tool}-${r.reason}`} className="text-xs text-slate-400">
                  <span className="mono text-slate-300">{r.tool}</span> — {r.message}
                </li>
              ))}
            </ul>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button
              type="button"
              className="btn btn-sm btn-secondary"
              onClick={() => downloadMuseKit(releaseId)}
            >
              Download Muse connector kit (.json)
            </button>
          </div>
          <p className="mt-2 text-xs text-slate-400">
            Paste the endpoint, capabilities and prefilled values into the intake form at{' '}
            <span className="mono">muse.ai/platform</span>. Directory listing stays a manual Meta review — this kit is the submission, not the approval.
          </p>
        </>
      )}
    </div>
  );
}

export default function PublishPage() {
  const { openBlockers, openWarnings, needsReview, approved, tools } = useReadiness();
  const project = useActiveProject();
  const liveBusy = useFoundryStore((s) => s.busy);
  const loadProject = useFoundryStore((s) => s.loadProject);
  const liveRelease = useFoundryStore((s) => s.release);
  const evalRun = useFoundryStore((s) => s.evalRun);
  const liveProjectId = project?.id ?? null;
  const [mcpCopied, setMcpCopied] = useState(false);
  const [gptCopied, setGptCopied] = useState(false);
  const createLiveRelease = useFoundryStore((s) => s.createRelease);
  const promoteLiveRelease = useFoundryStore((s) => s.promoteRelease);
  // FE-09: cutting/promoting a release is a project mutation.
  const access = useProjectAccess();
  // Queue visibility: an evaluation gates the readiness checklist below,
  // so a run in progress shows here too — and the project reloads when it
  // settles so the gates refresh.
  const queueEvals = useQueueJobs(liveProjectId, ['eval'], () => {
    if (liveProjectId) void loadProject(liveProjectId);
  });
  // Fresh data on arrival: the store may predate an eval that finished
  // elsewhere (the Evaluate screen, another tab) — the queue hook only
  // refires on transitions it observes, so without this the checklist sits
  // stale ("No evaluation run yet") until a manual refresh.
  useEffect(() => {
    if (liveProjectId) void loadProject(liveProjectId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveProjectId]);
  const queueEval = queueEvals[0] ?? null;

  // RL-08: prod promotion is certification-gated — fetch the readiness
  // checklist for the staged release so missing steps (and their fixes)
  // are visible before the customer ever clicks Promote.
  const [readiness, setReadiness] = useState<PromotionReadiness | null>(null);
  const [readinessLoading, setReadinessLoading] = useState(false);
  const [readinessError, setReadinessError] = useState<string | null>(null);
  const [readinessRetry, setReadinessRetry] = useState(0);
  const [promoteError, setPromoteError] = useState<string | null>(null);
  const [releaseError, setReleaseError] = useState<string | null>(null);

  const onCreateRelease = async () => {
    const v = window.prompt('Release version', liveRelease ? '0.1.1' : '0.1.0') ?? '';
    if (!v.trim()) return;
    setReleaseError(null);
    try {
      await createLiveRelease(v.trim());
    } catch (e: any) {
      // The backend names the exact gate (no tools / no credential /
      // untested tools) — show it instead of a bare 400.
      setReleaseError(e?.message ?? 'Release failed.');
    }
  };
  const liveReleaseId = liveRelease?.id;
  const liveChannel = liveRelease?.channel;
  // A new eval run under the same staged release changes readiness — refetch
  // on it too, not just on release/channel changes.
  const liveEvalRunId = evalRun?.id ?? null;
  useEffect(() => {
    if (!liveReleaseId || liveChannel !== 'staging') {
      setReadiness(null); setReadinessError(null); setReadinessLoading(false);
      return;
    }
    let live = true;
    setReadinessLoading(true);
    setReadinessError(null);
    getPromotionReadiness(liveReleaseId)
      .then((r) => { if (live) { setReadiness(r); setReadinessLoading(false); } })
      .catch((e) => {
        if (live) {
          setReadinessError(e instanceof Error ? e.message : String(e));
          setReadinessLoading(false);
        }
      });
    return () => { live = false; };
  }, [liveReleaseId, liveChannel, liveEvalRunId, readinessRetry]);

  const onPromote = async () => {
    setPromoteError(null);
    try {
      await promoteLiveRelease();
    } catch (e: any) {
      setPromoteError(e?.message ?? 'Promotion failed.');
      if (liveReleaseId) getPromotionReadiness(liveReleaseId).then(setReadiness).catch(() => {});
    }
  };
  if (!project) return <NoProject />;

  const passCount = evalRun?.passCount ?? 0;
  const scenarioCount = evalRun?.scenarioCount ?? 0;
  const evalPct = scenarioCount > 0 ? Math.round((passCount / scenarioCount) * 100) : 0;

  // Promotion gates computed from the store + latest eval run, so resolving
  // review items or approving tools updates this screen. The backend enforces
  // the real gates on release and promotion.
  const checklist: ChecklistItem[] = [
    { label: 'All blockers resolved', done: openBlockers.length === 0, detail: `${openBlockers.length} open` },
    {
      label: 'Eval pass rate ≥ 90%',
      done: scenarioCount > 0 && passCount / scenarioCount >= 0.9,
      detail: evalRun ? `${passCount}/${scenarioCount} (${evalPct}%)` : 'No evaluation run yet',
    },
    { label: 'Review queue empty', done: openWarnings.length === 0, detail: `${openWarnings.length} open` },
    {
      label: 'Tool approvals complete',
      done: tools.length > 0 && needsReview.length === 0,
      detail: `${approved.length}/${tools.length} approved`,
    },
  ];

  const doneCount = checklist.filter((c) => c.done).length;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="page-title">Publish</h1>
        <p className="page-sub">Freeze approved, evaluated tools of {project.name} into signed MCP + OpenAI releases.</p>
      </header>

      <ReadOnlyBanner reason={access.readOnlyReason} />

      {queueEval && <JobProgress job={queueEval} />}

      {/* Release */}
      {(
        <div className="card-pad">
          <SectionHeader
            title="Release"
            sub="Frozen, signed release — the backend gates block untested tools."
            action={
              <button
                type="button"
                disabled={liveBusy || !access.canEdit}
                title={access.readOnlyReason ?? undefined}
                onClick={() => void onCreateRelease()}
                className="btn btn-sm bg-neon text-ink-950 font-semibold border border-neon hover:bg-orange-300 disabled:bg-white/10 disabled:text-slate-500"
              >
                {liveBusy ? 'Working…' : liveRelease ? 'Cut new release' : 'Create release'}
              </button>
            }
          />
          {releaseError && <p className="text-xs text-red-300 mt-3">{releaseError}</p>}
          {liveRelease ? (
            <dl>
              <KvRow k="Version">
                <span className="inline-flex items-center gap-2">
                  <Badge tone="blue">{liveRelease.version}</Badge>
                  <Badge tone="green">approved</Badge>
                  <Badge tone={liveRelease.channel === 'prod' ? 'green' : 'blue'}>
                    {liveRelease.channel}
                  </Badge>
                </span>
              </KvRow>
              <KvRow k="Bundle hash">
                <span className="mono" title={liveRelease.manifest.integrity.bundle_hash}>
                  {String(liveRelease.manifest.integrity.bundle_hash).slice(0, 32)}…
                </span>
              </KvRow>
              <KvRow k="Tools">{liveRelease.manifest.tools.length}</KvRow>
              <KvRow k="Contract">
                <span className="text-xs text-amber-400">{liveRelease.manifest.provenance.contract_status}</span>
              </KvRow>
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={() => downloadManifest(liveRelease.id)}
                  className="btn btn-sm btn-secondary"
                >
                  Download release manifest
                </button>
                {liveRelease.channel === 'staging' ? (
                  <button
                    type="button"
                    disabled={liveBusy || !access.canEdit || (readiness ? !readiness.ready : false)}
                    title={access.readOnlyReason ?? undefined}
                    onClick={() => void onPromote()}
                    className="btn btn-sm bg-neon text-ink-950 font-semibold border border-neon hover:bg-orange-300 disabled:bg-white/10 disabled:text-slate-500"
                  >
                    {liveBusy ? 'Working…' : 'Promote to prod'}
                  </button>
                ) : (
                  <span className="text-xs text-slate-400">
                    Serving prod — invokes pinned to “prod” resolve to this release.
                  </span>
                )}
              </div>
              {liveRelease.channel === 'staging' && (
                <p className="mt-2 text-xs text-slate-400">
                  Staged: test it with invokes pinned to “staging” — prod traffic is untouched
                  until you promote.
                </p>
              )}
              {liveRelease.channel === 'staging' && (
                <div className="mt-4 rounded-xl border border-white/10 p-4">
                  <div className="flex items-center justify-between gap-3">
                    <h3 className="text-sm font-semibold text-slate-200">Promotion to prod — readiness</h3>
                    {readiness
                      ? readiness.ready
                        ? <Badge tone="green">Ready</Badge>
                        : <Badge tone="amber">Not ready</Badge>
                      : null}
                  </div>
                  <p className="text-xs text-slate-500 mt-1">
                    Prod is certification-gated: the latest completed evaluation must be certified.
                    Staging stays ungated.
                  </p>
                  {readinessPanelStatus({ readiness, loading: readinessLoading, error: readinessError }) === 'checking' ? (
                    <p className="text-xs text-slate-500 mt-3">Checking certification…</p>
                  ) : readiness ? (
                    <ul className="mt-3 space-y-2.5">
                      {readiness.checks.map((c) => (
                        <li key={c.id} className="flex gap-2 text-sm">
                          {c.status === 'pass'
                            ? <CheckCircle2 size={16} className="text-emerald-400 shrink-0 mt-0.5" />
                            : <XCircle size={16} className="text-red-400 shrink-0 mt-0.5" />}
                          <div>
                            <span className="text-slate-200">{c.label}</span>
                            <span className="text-slate-500"> — {c.detail}</span>
                            {c.status !== 'pass' && (
                              <div className="text-xs text-amber-200/80 mt-0.5">Next: {c.action}</div>
                            )}
                          </div>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <div className="mt-3 space-y-2">
                      <p className="text-xs text-red-300">
                        Couldn&apos;t load promotion readiness{readinessError ? `: ${readinessError}` : ''}.
                      </p>
                      <button
                        type="button"
                        className="btn btn-sm btn-secondary"
                        onClick={() => setReadinessRetry((n) => n + 1)}
                      >
                        Retry readiness check
                      </button>
                    </div>
                  )}
                  {promoteError && <p className="text-xs text-red-300 mt-3">{promoteError}</p>}
                </div>
              )}
            </dl>
          ) : (
            <p className="text-sm text-slate-400">
              No release yet. Approve tools and pass evaluation first — the backend enforces the gates.
            </p>
          )}
        </div>
      )}

      {/* RL-03: hosted MCP server for the live release */}
      {liveRelease && liveRelease.manifest && liveProjectId && (() => {
        const endpoint = mcpEndpointUrl(API_BASE, liveProjectId, liveRelease.channel);
        const serverName = mcpServerName(
          String(liveRelease.manifest?.connector?.name ?? '').replace(/-connector$/, ''));
        const config = mcpClientConfig(serverName, endpoint);
        return (
          <div className="card-pad">
            <SectionHeader
              title="MCP server"
              sub="This release is live as a hosted Model Context Protocol server — Claude connects directly."
            />
            <dl>
              <KvRow k="Endpoint"><span className="mono text-xs break-all">{endpoint}</span></KvRow>
              <KvRow k="Serves">
                <span className="text-sm text-slate-300">
                  The {liveRelease.channel} channel — {liveRelease.manifest.tools.length} evaluated tools
                </span>
              </KvRow>
            </dl>
            <pre className="mt-3 overflow-x-auto rounded-xl border border-white/10 bg-black/30 p-3 text-xs text-slate-200">{config}</pre>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <button
                type="button"
                className="btn btn-sm btn-secondary"
                onClick={() => {
                  try {
                    void navigator.clipboard?.writeText(config);
                    setMcpCopied(true);
                    window.setTimeout(() => setMcpCopied(false), 2000);
                  } catch { /* clipboard unavailable — the snippet stays selectable */ }
                }}
              >
                {mcpCopied ? 'Copied' : 'Copy client config'}
              </button>
              <button
                type="button"
                className="btn btn-sm btn-secondary"
                onClick={() => downloadStdioBridge(liveRelease.id)}
              >
                Download stdio bridge (.mjs)
              </button>
            </div>
            <p className="mt-2 text-xs text-slate-400">
              Replace <span className="mono">&lt;your-gateway-key&gt;</span> with a gateway key (Operate →
              Gateway keys). The stdio bridge reads the same key from{' '}
              <span className="mono">CF_GATEWAY_KEY</span> for local clients.
            </p>
          </div>
        );
      })()}

      {/* RL-04: OpenAI artifacts for the live release */}
      {liveRelease && liveRelease.manifest && (() => {
        const specUrl = gptActionsSpecUrl(API_BASE, liveRelease.id);
        const setup = gptActionsSetup(specUrl);
        return (
          <div className="card-pad">
            <SectionHeader
              title="OpenAI artifacts"
              sub="Function-calling schemas for the OpenAI API, plus a GPT Actions spec for custom GPTs — generated from this frozen release."
            />
            <dl>
              <KvRow k="Tools">{liveRelease.manifest.tools.length}</KvRow>
              <KvRow k="GPT Actions spec">
                <span className="mono text-xs break-all">{specUrl}</span>
              </KvRow>
            </dl>
            <pre className="mt-3 overflow-x-auto rounded-xl border border-white/10 bg-black/30 p-3 text-xs text-slate-200 whitespace-pre-wrap">{setup}</pre>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <button
                type="button"
                className="btn btn-sm btn-secondary"
                onClick={() => {
                  try {
                    void navigator.clipboard?.writeText(setup);
                    setGptCopied(true);
                    window.setTimeout(() => setGptCopied(false), 2000);
                  } catch { /* clipboard unavailable — the snippet stays selectable */ }
                }}
              >
                {gptCopied ? 'Copied' : 'Copy GPT setup steps'}
              </button>
              <button
                type="button"
                className="btn btn-sm btn-secondary"
                onClick={() => downloadOpenAiTools(liveRelease.id)}
              >
                Download function-calling tools (.json)
              </button>
              <button
                type="button"
                className="btn btn-sm btn-secondary"
                onClick={() => downloadGptActionsSpec(liveRelease.id)}
              >
                Open GPT Actions spec
              </button>
            </div>
            <p className="mt-2 text-xs text-slate-400">
              Function-calling tools call the connector through{' '}
              <span className="mono">POST /v1/runtime/invoke</span>; GPT Actions call the per-tool
              endpoints in the spec. Both authenticate with the same gateway key.
            </p>
          </div>
        );
      })()}

      {/* HK-08: Muse card only when the release targets Muse */}
      {liveRelease && liveRelease.manifest && (liveRelease.manifest?.connector?.targets ?? []).includes('muse') && (
        <MuseCard releaseId={liveRelease.id} />
      )}

      {/* Promotion checklist */}
      <div className="card-pad">
        <SectionHeader
          title="Promotion checklist"
          sub={`${doneCount} of ${checklist.length} gates satisfied`}
        />
        <div className="mb-4">
          <ProgressBar
            value={(doneCount / checklist.length) * 100}
            tone={doneCount === checklist.length ? 'green' : 'brand'}
          />
        </div>
        <ul className="divide-y divide-white/10">
          {checklist.map((item) => (
            <li key={item.label} className="flex items-start gap-3 py-3">
              {item.done ? (
                <CheckCircle2 className="h-5 w-5 text-green-600 shrink-0 mt-0.5" />
              ) : (
                <Circle className="h-5 w-5 text-slate-500 shrink-0 mt-0.5" />
              )}
              <div>
                <div className="text-sm font-medium text-slate-100">{item.label}</div>
                <div className="text-xs text-slate-400 mt-0.5">{item.detail}</div>
              </div>
            </li>
          ))}
        </ul>
      </div>

      <ReleaseInsights projectId={project.id} latestId={liveRelease?.id} canEdit={access.canEdit} />

      <VersionHistory projectId={project.id} latestId={liveRelease?.id} />
    </div>
  );
}
