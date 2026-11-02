import { useEffect, useState } from 'react';
import { Bot, Send } from 'lucide-react';
import { getReleaseChanges, runPlayground, type AgentTranscript, type ReleaseChanges } from '../../data/agent';
import { listReleases, type ReleaseSummary } from '../../data/api';
import { Badge, SectionHeader } from '../../shared/components/atoms';
import { TranscriptView } from '../evaluate/AgentPanels';

const text = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : String(v));

/**
 * 1.9: what changed for agents between the newest release and the one
 * before it, with each side's agent success rate from its evaluation.
 */
export function ReleaseChangesPanel({ releases }: { releases: ReleaseSummary[] }) {
  const newest = releases[0];
  const [data, setData] = useState<ReleaseChanges | null>(null);
  useEffect(() => {
    if (!newest) return;
    let live = true;
    getReleaseChanges(newest.id).then((d) => { if (live) setData(d); }).catch(() => { if (live) setData(null); });
    return () => { live = false; };
  }, [newest?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!newest || !data?.base) return null;
  const rate = (side: 'release' | 'base') => data.eval[side]?.summary?.agent?.metrics?.success_rate;
  return (
    <div className="card-pad">
      <SectionHeader
        title={`What changed: ${data.base.version} → ${data.release.version}`}
        sub="The text and access agents see, tool by tool."
        action={rate('base') !== undefined && rate('release') !== undefined ? (
          <Badge tone={(rate('release') ?? 0) >= (rate('base') ?? 0) ? 'green' : 'red'}>
            Agent task success {rate('base')}% → {rate('release')}%
          </Badge>
        ) : undefined}
      />
      {data.changes.length === 0 ? (
        <p className="text-sm text-slate-400">No tool changes between these releases.</p>
      ) : (
        <ul className="space-y-3">
          {data.changes.map((c) => (
            <li key={c.tool} className="rounded-lg border border-white/10 p-3">
              <div className="flex items-center gap-2">
                <span className="mono text-sm text-slate-100">{c.tool}</span>
                <Badge tone={c.change === 'added' ? 'green' : c.change === 'removed' ? 'red' : 'blue'}>{c.change}</Badge>
              </div>
              {c.fields?.map((f) => (
                <div key={f.field} className="grid gap-2 md:grid-cols-[8rem_1fr_1fr] text-xs mt-2">
                  <span className="text-slate-500">{f.field.replace('param:', 'argument ')}</span>
                  <span className="text-slate-400 whitespace-pre-wrap break-words line-through decoration-red-400/50">{text(f.before)}</span>
                  <span className="text-slate-100 whitespace-pre-wrap break-words">{text(f.after)}</span>
                </div>
              ))}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Try a release with an agent: a prompt runs through the data plane exactly
 * like an external agent's calls, and shows up in Operate as a playground
 * call triggered by a user prompt.
 */
export function PlaygroundPanel({ projectId, releases, canEdit }: { projectId: string; releases: ReleaseSummary[]; canEdit: boolean }) {
  const [prompt, setPrompt] = useState('');
  const [version, setVersion] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ release_version: string; transcript: AgentTranscript } | null>(null);
  const usable = releases.filter((r) => r.status === 'approved');
  const options = [
    ...(usable.some((r) => r.channel === 'prod') ? [{ value: 'prod', label: 'prod channel' }] : []),
    ...(usable.some((r) => r.channel === 'staging') ? [{ value: 'staging', label: 'staging channel' }] : []),
    ...usable.map((r) => ({ value: r.version, label: `v${r.version}` })),
  ];
  const selected = version || options[0]?.value || '';

  if (usable.length === 0) return null;

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      setResult(await runPlayground(projectId, prompt.trim(), selected));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card-pad">
      <SectionHeader title="Try it with an agent" sub="Ask what your users would ask. The agent calls the released tools live." />
      <form className="flex flex-col sm:flex-row gap-2" onSubmit={(e) => { e.preventDefault(); if (prompt.trim()) void run(); }}>
        <label htmlFor="playground-release" className="sr-only">Release</label>
        <select id="playground-release" className="input sm:w-44" value={selected} onChange={(e) => setVersion(e.target.value)}>
          {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <label htmlFor="playground-prompt" className="sr-only">Prompt</label>
        <input id="playground-prompt" className="input flex-1" value={prompt} maxLength={2000}
          onChange={(e) => setPrompt(e.target.value)} placeholder="e.g. What can you tell me about…" disabled={!canEdit} />
        <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !prompt.trim() || !canEdit}>
          {busy ? <Bot className="h-4 w-4 animate-pulse" /> : <Send className="h-4 w-4" />}
          {busy ? 'Working…' : 'Ask'}
        </button>
      </form>
      {error && <p className="text-sm text-red-300 mt-3">{error}</p>}
      {result && (
        <div className="mt-4">
          <TranscriptView label={`Release ${result.release_version}`} transcript={result.transcript} />
        </div>
      )}
    </div>
  );
}

/** Loads the project's releases once and renders the changes + playground panels. */
export function ReleaseInsights({ projectId, latestId, canEdit }: { projectId: string; latestId: string | undefined; canEdit: boolean }) {
  const [releases, setReleases] = useState<ReleaseSummary[]>([]);
  useEffect(() => {
    let live = true;
    listReleases(projectId).then(({ releases: r }) => { if (live) setReleases(r); }).catch(() => { if (live) setReleases([]); });
    return () => { live = false; };
  }, [projectId, latestId]);
  return (
    <>
      <ReleaseChangesPanel releases={releases} />
      <PlaygroundPanel projectId={projectId} releases={releases} canEdit={canEdit} />
    </>
  );
}
