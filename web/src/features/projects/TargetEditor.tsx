import { Check } from 'lucide-react';
import { TARGET_OPTIONS, type ConnectorTarget, type ProjectSummary } from '../../data/projects';

/** Edit a project's connector targets — add or remove, all in the current
 *  version. At least one target must stay selected. Shared by the projects
 *  list (inline edit) and the project detail page. */
export default function TargetEditor({
  project,
  draft,
  onToggle,
  onSave,
  busy,
}: {
  project: ProjectSummary;
  draft: ConnectorTarget[];
  onToggle: (id: ConnectorTarget) => void;
  onSave: () => void;
  busy: boolean;
}) {
  const same = [...draft].sort().join(',') === [...project.targets].sort().join(',');
  const changed = draft.length > 0 && !same;

  return (
    <div className="rounded-lg border border-white/10 bg-white/5 p-3 space-y-2">
      <div className="micro-label">Connector targets</div>
      {TARGET_OPTIONS.map((t) => (
        <label
          key={t.id}
          className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer"
        >
          <input
            type="checkbox"
            checked={draft.includes(t.id)}
            onChange={() => onToggle(t.id)}
            className="accent-[#ffa02e]"
          />
          <span className="font-medium">{t.label}</span>
          {t.badge && <span className="badge badge-gray !text-[10px]">{t.badge}</span>}
        </label>
      ))}
      <p className="text-[11px] text-slate-500 leading-relaxed">
        Applies to this project&apos;s current version. Keep at least one target selected.
      </p>
      <button
        onClick={onSave}
        disabled={!changed || busy}
        className="btn-primary btn-sm disabled:opacity-40"
      >
        <Check size={12} /> {busy ? 'Saving…' : 'Save targets'}
      </button>
    </div>
  );
}
