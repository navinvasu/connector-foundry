import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { AlertTriangle, ArrowLeft, Check, RotateCcw, Save, XCircle } from 'lucide-react';
import { useFoundryStore, useProjectAccess } from '../../app/store';
import type { AgentTool, ErrorMapping } from '../../data/types';
import { Badge, EffectBadge, EmptyState, KvRow, SectionHeader } from '../../shared/components/atoms';
import ReadOnlyBanner from '../../shared/components/ReadOnlyBanner';
import TryItPanel from '../../shared/components/TryItPanel';

const statusTone: Record<AgentTool['status'], 'green' | 'amber' | 'gray' | 'blue'> = {
  approved: 'green',
  needs_review: 'amber',
  excluded: 'gray',
  draft: 'blue',
};

const statusLabel: Record<AgentTool['status'], string> = {
  approved: 'Approved',
  needs_review: 'Needs review',
  excluded: 'Excluded',
  draft: 'Draft',
};

const actionTone: Record<ErrorMapping['action'], 'blue' | 'amber' | 'purple' | 'red' | 'gray'> = {
  retry: 'blue',
  fix_params: 'amber',
  refresh_auth: 'purple',
  backoff: 'amber',
  escalate: 'red',
  clarify: 'gray',
};

export default function ToolDetailPage() {
  const { toolName } = useParams<{ toolName: string }>();
  const tool = useFoundryStore((s) => s.tools.find((t) => t.name === toolName));
  const approveTool = useFoundryStore((s) => s.approveTool);
  const excludeTool = useFoundryStore((s) => s.excludeTool);
  const reopenTool = useFoundryStore((s) => s.reopenTool);
  const updateTool = useFoundryStore((s) => s.updateTool);
  // FE-09: viewers browse the contract read-only (see ToolsPage banner).
  const access = useProjectAccess();

  const [intent, setIntent] = useState(tool?.intent ?? '');
  const [description, setDescription] = useState(tool?.description ?? '');
  const [effect, setEffect] = useState(tool?.effect ?? 'READ');
  const [confirmation, setConfirmation] = useState(tool?.confirmation ?? 'NEVER');
  const [saved, setSaved] = useState(false);

  // Re-sync the editable fields when navigating between tools — and when the
  // tool first arrives (the store loads async, so the useState initializers
  // above run while tool is still undefined and would otherwise stick).
  // Keyed on presence, not on the tool object, so background store refreshes
  // of the same tool don't wipe in-progress edits.
  const syncKey = tool ? toolName : '';
  useEffect(() => {
    setIntent(tool?.intent ?? '');
    setDescription(tool?.description ?? '');
    setEffect(tool?.effect ?? 'READ');
    setConfirmation(tool?.confirmation ?? 'NEVER');
    setSaved(false);
  }, [syncKey]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!tool) {
    return (
      <div className="space-y-6">
        <Link
          to="/tools"
          className="inline-flex items-center gap-1.5 text-sm text-orange-300 hover:text-orange-300"
        >
          <ArrowLeft size={16} /> All tools
        </Link>
        <EmptyState
          title="Tool not found"
          sub={`No tool named "${toolName ?? ''}" exists in this project.`}
          action={
            <Link to="/tools" className="btn-secondary btn-sm">
              Browse all tools
            </Link>
          }
        />
      </div>
    );
  }

  const handleExclude = () => {
    const reason = window.prompt('Why is this tool being excluded?');
    excludeTool(tool.name, reason || 'Excluded by reviewer');
  };

  const handleSave = () => {
    updateTool(tool.name, { intent, description, effect, confirmation });
    setSaved(true);
  };

  const markDirty = (setter: (v: string) => void) => (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setter(e.target.value);
    setSaved(false);
  };

  return (
    <div className="space-y-6">
      <Link
        to="/tools"
        className="inline-flex items-center gap-1.5 text-sm text-orange-300 hover:text-orange-300"
      >
        <ArrowLeft size={16} /> All tools
      </Link>

      <div>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="page-title mono">{tool.name}</h1>
          <Badge tone={statusTone[tool.status]}>{statusLabel[tool.status]}</Badge>
          <Badge tone="gray" className="mono">
            {tool.version}
          </Badge>
        </div>
        <p className="page-sub mono">{tool.upstream}</p>
      </div>

      <ReadOnlyBanner reason={access.readOnlyReason} />

      <TryItPanel tool={tool} disabledReason={access.canEdit ? null : access.readOnlyReason} />

      {/* Agent contract */}
      <div className="card-pad">
        <SectionHeader
          title="Agent contract"
          sub="How the agent discovers, describes, and safely calls this tool."
        />
        <dl>
          <KvRow k="Intent">{tool.intent}</KvRow>
          <KvRow k="Description">{tool.description}</KvRow>
          <KvRow k="Effect">
            <EffectBadge effect={tool.effect} />
          </KvRow>
          <KvRow k="Confirmation">
            <span className="mono">{tool.confirmation}</span>
          </KvRow>
          <KvRow k="Idempotency">
            <span className="mono">{tool.idempotency}</span>
          </KvRow>
          <KvRow k="Retry policy">{tool.retry}</KvRow>
          <KvRow k="Scopes">
            <span className="flex flex-wrap justify-end gap-1">
              {tool.scopes.map((s) => (
                <Badge key={s} tone="gray" className="mono">
                  {s}
                </Badge>
              ))}
            </span>
          </KvRow>
          <KvRow k="Upstream">
            <span className="mono text-slate-400">{tool.upstream}</span>
          </KvRow>
        </dl>
        {tool.breakingChange && (
          <div className="mt-4 flex gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4">
            <AlertTriangle size={18} className="text-amber-600 shrink-0 mt-0.5" />
            <div>
              <div className="text-sm font-medium text-amber-800">Breaking change</div>
              <div className="text-sm text-amber-700 mt-0.5">{tool.breakingChange}</div>
            </div>
          </div>
        )}
      </div>

      {/* Editable */}
      <div className="card-pad">
        <SectionHeader
          title="Editable"
          sub="Generated items stay editable until release. Changes apply to this draft immediately."
          action={
            saved ? (
              <span className="inline-flex items-center gap-1 text-xs font-medium text-green-700">
                <Check size={14} /> Saved
              </span>
            ) : undefined
          }
        />
        <label className="label" htmlFor="tool-intent">
          Intent
        </label>
        <textarea
          id="tool-intent"
          className="input"
          rows={2}
          value={intent}
          disabled={!access.canEdit}
          onChange={markDirty(setIntent)}
        />
        <label className="label mt-4" htmlFor="tool-description">
          Description
        </label>
        <textarea
          id="tool-description"
          className="input"
          rows={3}
          value={description}
          disabled={!access.canEdit}
          onChange={markDirty(setDescription)}
        />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-4">
          <div>
            <label className="label" htmlFor="tool-effect">
              Effect class
            </label>
            <select
              id="tool-effect"
              className="input"
              value={effect}
              disabled={!access.canEdit || effect === 'UNKNOWN'}
              onChange={(e) => { setEffect(e.target.value as typeof effect); setSaved(false); }}
              title={effect === 'UNKNOWN' ? 'Effect could not be classified — re-import or contact support' : 'What this tool does to the world'}
            >
              <option value="READ">Read-only — only reads data</option>
              <option value="WRITE">Mutating — changes data</option>
              <option value="DESTRUCTIVE">Destructive — deletes or destroys</option>
              {effect === 'UNKNOWN' && <option value="UNKNOWN">Unknown</option>}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="tool-confirmation">
              Confirmation rule
            </label>
            <select
              id="tool-confirmation"
              className="input"
              value={confirmation}
              disabled={!access.canEdit}
              onChange={(e) => { setConfirmation(e.target.value as typeof confirmation); setSaved(false); }}
              title="Whether the agent must ask the user before calling"
            >
              <option value="ALWAYS">Always ask before calling</option>
              <option value="NEVER">Never ask</option>
            </select>
          </div>
        </div>
        <p className="text-xs text-slate-500 mt-2">
          Confirm the effect class and confirmation rule here, then approve below — this is what resolves a “mutating operation requires a decision” review item.
        </p>
        <div className="mt-4">
          <button className="btn-primary disabled:opacity-40" onClick={handleSave} disabled={!access.canEdit} title={access.readOnlyReason ?? undefined}>
            <Save size={16} /> Save changes
          </button>
        </div>
      </div>

      {/* Input schema */}
      <div className="card overflow-hidden">
        <div className="p-5 pb-0">
          <SectionHeader
            title="Input schema"
            sub={`${tool.inputSchema.length} parameter${tool.inputSchema.length === 1 ? '' : 's'}`}
          />
        </div>
        <div className="overflow-x-auto"><table className="w-full">
          <thead>
            <tr className="border-y border-white/10 bg-white/5">
              <th className="table-th">Name</th>
              <th className="table-th">Type</th>
              <th className="table-th">Required</th>
              <th className="table-th">Description</th>
            </tr>
          </thead>
          <tbody>
            {tool.inputSchema.map((p) => (
              <tr key={p.name} className="border-b border-white/10 last:border-0">
                <td className="table-td mono font-medium">{p.name}</td>
                <td className="table-td">
                  <Badge tone="purple" className="mono">
                    {p.type}
                  </Badge>
                </td>
                <td className="table-td">
                  {p.required ? <Badge tone="green">required</Badge> : <Badge tone="gray">optional</Badge>}
                </td>
                <td className="table-td">{p.description}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
      </div>

      {/* Upstream binding */}
      <div className="card overflow-hidden">
        <div className="p-5 pb-0">
          <SectionHeader
            title="Upstream binding"
            sub="How each tool argument maps onto the GitHub REST request."
          />
        </div>
        <div className="overflow-x-auto"><table className="w-full">
          <thead>
            <tr className="border-y border-white/10 bg-white/5">
              <th className="table-th">Tool argument</th>
              <th className="table-th">Location</th>
              <th className="table-th">Upstream parameter</th>
            </tr>
          </thead>
          <tbody>
            {tool.bindings.map((b) => (
              <tr key={b.arg} className="border-b border-white/10 last:border-0">
                <td className="table-td mono font-medium">{b.arg}</td>
                <td className="table-td">
                  <Badge tone="blue" className="mono">
                    {b.location}
                  </Badge>
                </td>
                <td className="table-td mono">{b.target}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
      </div>

      {/* Error mappings */}
      <div className="card overflow-hidden">
        <div className="p-5 pb-0">
          <SectionHeader
            title="Error mappings"
            sub="Failures map to defined recovery actions, not just renamed errors."
          />
        </div>
        <div className="overflow-x-auto"><table className="w-full">
          <thead>
            <tr className="border-y border-white/10 bg-white/5">
              <th className="table-th">Raw error</th>
              <th className="table-th">Mapped</th>
              <th className="table-th">Action</th>
              <th className="table-th">Recovery</th>
            </tr>
          </thead>
          <tbody>
            {tool.errorMappings.map((e) => (
              <tr key={e.raw} className="border-b border-white/10 last:border-0">
                <td className="table-td mono">{e.raw}</td>
                <td className="table-td">
                  <Badge tone="blue" className="mono">
                    {e.mapped}
                  </Badge>
                </td>
                <td className="table-td">
                  <Badge tone={actionTone[e.action]} className="mono">
                    {e.action}
                  </Badge>
                </td>
                <td className="table-td">{e.recovery}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
      </div>

      {/* Footer actions */}
      <div className="flex gap-2">
        {(tool.status === 'needs_review' || tool.status === 'draft') && (
          <button className="btn-primary disabled:opacity-40" onClick={() => approveTool(tool.name)} disabled={!access.canEdit} title={access.readOnlyReason ?? undefined}>
            <Check size={16} /> Approve
          </button>
        )}
        {tool.status !== 'excluded' && (
          <button className="btn-secondary disabled:opacity-40" onClick={handleExclude} disabled={!access.canEdit} title={access.readOnlyReason ?? undefined}>
            <XCircle size={16} /> Exclude
          </button>
        )}
        {tool.status === 'excluded' && (
          <button className="btn-ghost disabled:opacity-40" onClick={() => reopenTool(tool.name)} disabled={!access.canEdit} title={access.readOnlyReason ?? undefined}>
            <RotateCcw size={16} /> Reopen
          </button>
        )}
      </div>
    </div>
  );
}
