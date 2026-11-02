import { useState } from 'react';
import type { Telemetry, TelemetryBucket } from '../../data/api';
import { setPromptCapture } from '../../data/agent';
import { Badge, SectionHeader } from '../../shared/components/atoms';
import { cn } from '../../shared/lib/utils';

// D-89: who and what drives the calls. Triggers are declared by callers that
// know (the playground, agents sending `_meta`) and otherwise inferred from
// session timing; third-party agents never send the user's prompt, so prompt
// text appears only when declared AND the project opted in.

const TRIGGER_LABEL: Record<string, string> = {
  user_prompt: 'User prompt',
  agent_followup: 'Agent follow-up',
  automated: 'Automated',
  unknown: 'Unattributed',
};

const CHANNEL_LABEL: Record<string, string> = {
  mcp: 'MCP',
  openai_actions: 'GPT Actions',
  rest: 'REST invoke',
  playground: 'Console playground',
  unknown: 'Unattributed',
};

function Bars({ title, rows, label }: { title: string; rows: TelemetryBucket[]; label?: (k: string) => string }) {
  const max = Math.max(...rows.map((r) => r.calls), 1);
  const total = rows.reduce((s, r) => s + r.calls, 0);
  return (
    <div>
      <h3 className="text-sm font-medium text-slate-200 mb-3">{title}</h3>
      {rows.length === 0 ? (
        <p className="text-xs text-slate-500">No calls in this window.</p>
      ) : (
        <div className="space-y-2.5">
          {rows.map((r) => {
            const name = label ? label(r.key) : r.key;
            const pct = total ? Math.round((r.calls / total) * 100) : 0;
            const okPct = r.calls ? Math.round((r.ok_calls / r.calls) * 100) : 0;
            return (
              <div key={r.key} title={`${name}: ${r.calls} calls (${pct}%), ${okPct}% ok, ${Math.round(r.avg_ms)}ms avg`}>
                <div className="flex items-center justify-between gap-3 text-xs mb-1">
                  <span className="text-slate-300 truncate">{name}</span>
                  <span className="text-slate-500 shrink-0">{r.calls.toLocaleString()} · {pct}% · {okPct}% ok</span>
                </div>
                <div className="h-2 rounded-full bg-white/5 overflow-hidden">
                  <div className="h-full rounded-full bg-neon/70" style={{ width: `${Math.max((r.calls / max) * 100, 2)}%` }} />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function AttributionSection({ projectId, telemetry, canEdit, onChanged }: {
  projectId: string;
  telemetry: Telemetry;
  canEdit: boolean;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const capture = telemetry.capture_prompts === true;
  const prompts = telemetry.top_prompts ?? [];

  const toggle = async () => {
    setBusy(true);
    setError(null);
    try {
      await setPromptCapture(projectId, !capture);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card-pad">
      <SectionHeader
        title="Who calls, and why"
        sub="User prompts vs agent follow-ups vs automated jobs, by client, channel and release."
        action={canEdit ? (
          <label className="inline-flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
            <input type="checkbox" checked={capture} disabled={busy} onChange={() => void toggle()} />
            Capture prompts (redacted)
          </label>
        ) : undefined}
      />
      {error && <p className="text-sm text-red-300 mb-3">{error}</p>}
      <div className="grid gap-6 md:grid-cols-2">
        <Bars title="Trigger" rows={telemetry.by_trigger ?? []} label={(k) => TRIGGER_LABEL[k] ?? k} />
        <Bars title="Client" rows={telemetry.by_client ?? []} label={(k) => (k === 'unknown' ? 'Unattributed' : k)} />
        <Bars title="Channel" rows={telemetry.by_channel ?? []} label={(k) => CHANNEL_LABEL[k] ?? k} />
        <Bars title="Release version" rows={telemetry.by_release ?? []} />
      </div>

      <div className="mt-6">
        <h3 className="text-sm font-medium text-slate-200 mb-2">Top prompts</h3>
        {!capture ? (
          <p className="text-xs text-slate-500">
            Prompt capture is off. When on, prompts that callers share (the playground, or agents sending
            <span className="mono"> connectorfoundry.com/prompt</span>) are stored redacted. Claude, ChatGPT and Muse
            don&apos;t share user prompts with tool servers, so their calls show as &ldquo;not shared&rdquo;.
          </p>
        ) : prompts.length === 0 ? (
          <p className="text-xs text-slate-500">No shared prompts in this window yet.</p>
        ) : (
          <ul className="space-y-1.5">
            {prompts.map((p) => (
              <li key={p.prompt} className="flex items-start justify-between gap-3 rounded-md bg-white/5 px-3 py-2">
                <span className="text-sm text-slate-200 break-words min-w-0">{p.prompt}</span>
                <span className="text-xs text-slate-500 shrink-0">{p.calls} calls · {p.turns} turns</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** Trigger cell for the invocations table: label + declared/inferred marker. */
export function TriggerCell({ trigger, source }: { trigger?: string | null; source?: string | null }) {
  const key = trigger ?? 'unknown';
  return (
    <span className="inline-flex items-center gap-1.5">
      <Badge tone={key === 'user_prompt' ? 'blue' : key === 'agent_followup' ? 'purple' : key === 'automated' ? 'gray' : 'gray'}>
        {TRIGGER_LABEL[key] ?? key}
      </Badge>
      {source === 'inferred' && key !== 'unknown' && <span className={cn('text-[11px] text-slate-500')}>inferred</span>}
    </span>
  );
}
