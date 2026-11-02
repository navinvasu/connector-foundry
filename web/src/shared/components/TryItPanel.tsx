// Try-it panel — invoke a live tool through the data plane and see the real
// response. Mounted on the tool detail page.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useFoundryStore } from '../../app/store';
import type { AgentTool } from '../../data/types';
import { invokeTool } from '../../data/api';
import { Badge, KvRow, SectionHeader } from './atoms';

// Sensible one-click defaults keyed by common param names.
const DEFAULTS: Record<string, string> = {
  latitude: '37.7749',
  longitude: '-122.4194',
  name: 'Boston',
};

function coerce(type: string, raw: string): unknown {
  if (raw.trim() === '') return undefined;
  if (type === 'number' || type === 'integer') {
    const n = Number(raw);
    return Number.isNaN(n) ? raw : n;
  }
  if (type === 'boolean') return raw.toLowerCase() === 'true';
  return raw;
}

export default function TryItPanel({ tool, disabledReason }: { tool: AgentTool; disabledReason?: string | null }) {
  const projectId = useFoundryStore((s) => s.activeProjectId);
  const release = useFoundryStore((s) => s.release);
  const storeBusy = useFoundryStore((s) => s.busy);
  const loadTelemetry = useFoundryStore((s) => s.loadTelemetry);

  const [args, setArgs] = useState<Record<string, string>>(() =>
    Object.fromEntries(tool.inputSchema.map((p) => [p.name, DEFAULTS[p.name] ?? ''])),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<any | null>(null);

  // FE-09: invoking writes real telemetry, so it follows the same
  // owner/editor gate as the other project mutations.
  const canInvoke = !!projectId && !!release && !busy && !storeBusy && !disabledReason;

  const run = async () => {
    if (!projectId || !release) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const parsed: Record<string, unknown> = {};
      for (const p of tool.inputSchema) {
        const v = coerce(p.type, args[p.name] ?? '');
        if (v !== undefined) parsed[p.name] = v;
      }
      const r = await invokeTool(projectId, release.version, tool.name, parsed);
      setResult(r);
      loadTelemetry().catch(() => {});
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card-pad">
      <SectionHeader
        title="Try it"
        sub={`Live invocation through the data plane — pinned to release ${release?.version ?? '—'}. Writes to real telemetry.`}
        action={
          <button
            type="button"
            onClick={run}
            disabled={!canInvoke}
            title={disabledReason ?? undefined}
            className="btn btn-sm bg-neon text-ink-950 font-semibold border border-neon hover:bg-orange-300 disabled:bg-white/10 disabled:text-slate-500"
          >
            {busy ? 'Invoking…' : 'Invoke'}
          </button>
        }
      />
      {disabledReason && <p className="text-sm text-slate-400 mb-4">{disabledReason}</p>}
      {!release ? (
        <p className="text-sm text-slate-400">
          The data plane only serves pinned releases.{' '}
          <Link to="/publish" className="text-orange-300 hover:text-orange-200">
            Create a release on the Publish page
          </Link>{' '}
          first, then come back and try it.
        </p>
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {tool.inputSchema.map((p) => (
              <div key={p.name}>
                <label className="label" htmlFor={`try-${p.name}`}>
                  <span className="mono">{p.name}</span>
                  {p.required && <span className="text-red-400 ml-1">*</span>}
                  <span className="text-slate-500 ml-2">{p.type}</span>
                </label>
                <input
                  id={`try-${p.name}`}
                  className="input mono"
                  value={args[p.name] ?? ''}
                  placeholder={p.description || p.name}
                  onChange={(e) => setArgs((a) => ({ ...a, [p.name]: e.target.value }))}
                />
              </div>
            ))}
          </div>
          {error && <p className="text-sm text-red-400 mt-4">{error}</p>}
          {result && (
            <dl className="mt-4">
              <KvRow k="Status">
                <Badge tone={result.ok ? 'green' : 'red'}>{result.ok ? 'ok' : 'error'}</Badge>
              </KvRow>
              <KvRow k="Latency">
                <span className="mono">{result.latency_ms}ms</span>
              </KvRow>
              <KvRow k="Tool">
                <span className="mono text-xs">{result.tool} @ {result.release_version}</span>
              </KvRow>
              <div className="mt-3">
                <div className="text-xs text-slate-500 mb-1">Response (truncated)</div>
                <pre className="mono text-xs bg-black/40 border border-white/10 rounded-lg p-3 overflow-x-auto max-h-64 overflow-y-auto">
                  {JSON.stringify(result.result ?? result.error ?? result, null, 2).slice(0, 2000)}
                </pre>
              </div>
              <p className="text-xs text-slate-500 mt-3">
                Recorded in telemetry — check the <Link to="/operate" className="text-orange-300 hover:text-orange-200">Operate</Link> page's Live invocations card.
              </p>
            </dl>
          )}
        </>
      )}
    </div>
  );
}
