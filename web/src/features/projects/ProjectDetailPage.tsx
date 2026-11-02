import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, ExternalLink, KeyRound } from 'lucide-react';
import { useFoundryStore } from '../../app/store';
import { accessForProject } from '../../data/permissions';
import {
  ENDUSER_AUTH_OPTIONS, UPSTREAM_AUTH_OPTIONS, formatTargets,
  type ConnectorTarget, type ProjectSummary,
} from '../../data/projects';
import { getProject, updateProject as patchProject } from '../../data/api';
import CredentialsCard from '../tools/CredentialsCard';
import TargetEditor from './TargetEditor';
import { EmptyState, ErrorState, SectionHeader } from '../../shared/components/atoms';

/** Project detail page — the one place to change what a project is and how
 *  it authenticates. Upstream credentials live here (not on Tools):
 *  an API key through the vault-backed card, or a future access token via
 *  browser login (disabled for the demo). End-user authentication names how
 *  callers invoke the connector: gateway keys today, auth-based login later. */
export default function ProjectDetailPage() {
  const { id } = useParams<{ id: string }>();
  const me = useFoundryStore((s) => s.me);
  const storeUpdate = useFoundryStore((s) => s.updateProject);

  const [project, setProject] = useState<ProjectSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [targets, setTargets] = useState<ConnectorTarget[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    setLoadError(null);
    getProject(id)
      .then((p) => {
        setProject(p);
        setName(p.name);
        setDescription(p.blurb === 'No description yet.' ? '' : p.blurb);
        setTargets(p.targets);
      })
      .catch((e: any) => setLoadError(e.message ?? String(e)))
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) return <p className="text-sm text-slate-500">Loading project…</p>;
  if (loadError || !project) {
    return (
      <ErrorState
        message={loadError ? `Couldn't load this project: ${loadError}` : 'Project not found.'}
        hint="Back to the registry to pick another project."
        onRetry={() => window.location.reload()}
      />
    );
  }

  const access = accessForProject(me, project);
  const detailsChanged =
    name.trim().length > 0 &&
    (name.trim() !== project.name || description.trim() !== (project.blurb === 'No description yet.' ? '' : project.blurb));
  const targetsChanged =
    targets.length > 0 && [...targets].sort().join(',') !== [...project.targets].sort().join(',');

  const saveDetails = async () => {
    if (!id || !detailsChanged || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const { project: row } = await patchProject(id, {
        name: name.trim(),
        description: description.trim() || null,
      });
      const patch: Partial<ProjectSummary> = {
        name: row.name,
        blurb: row.description?.trim() || 'No description yet.',
      };
      setProject((p) => (p ? { ...p, ...patch } : p));
      storeUpdate(id, patch);
      setSaved(true);
    } catch (e: any) {
      setSaveError(e.message ?? String(e));
    } finally {
      setSaving(false);
    }
  };

  const saveTargets = async () => {
    if (!id || !targetsChanged || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      await patchProject(id, { targets });
      setProject((p) => (p ? { ...p, targets } : p));
      storeUpdate(id, { targets });
      setSaved(true);
    } catch (e: any) {
      setSaveError(e.message ?? String(e));
    } finally {
      setSaving(false);
    }
  };

  const tokenOpt = UPSTREAM_AUTH_OPTIONS.find((o) => o.id === 'access_token')!;

  return (
    <div className="space-y-6 max-w-3xl">
      <Link to="/projects" className="inline-flex items-center gap-1.5 text-sm text-orange-300 hover:underline">
        <ArrowLeft size={16} /> All projects
      </Link>

      <div>
        <h1 className="page-title">{project.name}</h1>
        <p className="page-sub">
          {formatTargets(project.targets)} · {project.version} · updated {project.updatedAt}
        </p>
      </div>

      {saved && (
        <p className="text-xs text-emerald-300" role="status">Saved.</p>
      )}
      {saveError && <p className="text-xs text-red-300">{saveError}</p>}

      {/* Details */}
      <div className="card-pad">
        <SectionHeader title="Project details" sub="Name, description, and connector targets." />
        <fieldset disabled={!access.canEdit} title={access.readOnlyReason ?? undefined}>
          <label className="label" htmlFor="pd-name">Project name</label>
          <input
            id="pd-name"
            className="input"
            value={name}
            onChange={(e) => { setName(e.target.value); setSaved(false); }}
          />
          <label className="label mt-4" htmlFor="pd-desc">Description</label>
          <textarea
            id="pd-desc"
            className="input min-h-[80px] resize-y"
            value={description}
            onChange={(e) => { setDescription(e.target.value); setSaved(false); }}
          />
          <div className="mt-4">
            <TargetEditor
              project={{ ...project, targets }}
              draft={targets}
              onToggle={(t) => { setTargets((ts) => (ts.includes(t) ? ts.filter((x) => x !== t) : [...ts, t])); setSaved(false); }}
              onSave={() => void saveTargets()}
              busy={saving}
            />
          </div>
          <button
            className="btn-primary btn-sm mt-4 disabled:opacity-40"
            disabled={!detailsChanged || saving || !access.canEdit}
            onClick={() => void saveDetails()}
          >
            {saving ? 'Saving…' : 'Save details'}
          </button>
        </fieldset>
        {!access.canEdit && access.readOnlyReason && (
          <p className="text-xs text-slate-500 mt-2">{access.readOnlyReason}</p>
        )}
      </div>

      {/* Upstream authentication */}
      <div className="card-pad">
        <SectionHeader
          title="Upstream authentication"
          sub="How this connector proves itself to your API. Keys live in the server vault — switch methods here."
        />
        <div className="rounded-xl border border-neon/30 bg-neon/5 p-4 mb-3">
          <div className="flex items-center gap-2 mb-3">
            <KeyRound size={16} className="text-neon" />
            <h3 className="text-sm font-medium text-slate-100">Upstream API key</h3>
            <span className="badge badge-blue !text-[10px] ml-auto">Active method</span>
          </div>
          {id && <CredentialsCard projectId={id} />}
        </div>
        <div className="rounded-xl border border-white/10 p-4 opacity-60">
          <div className="flex items-center gap-2">
            <ExternalLink size={16} className="text-slate-500" />
            <h3 className="text-sm font-medium text-slate-100">{tokenOpt.label}</h3>
            <span className="badge badge-gray !text-[10px] ml-auto">Demo: disabled</span>
          </div>
          <p className="text-xs text-slate-500 mt-1.5 leading-relaxed">{tokenOpt.desc}</p>
          {tokenOpt.disabledNote && (
            <p className="text-xs text-amber-300/90 mt-1.5">{tokenOpt.disabledNote}</p>
          )}
          <label className="label mt-3" htmlFor="pd-login-uri">Login URI</label>
          <input id="pd-login-uri" className="input mono" placeholder="https://api.example.com/login" disabled />
          <button type="button" className="btn-secondary btn-sm mt-2" disabled title="Access-token login is disabled for the demo">
            <ExternalLink size={14} /> Launch browser login
          </button>
        </div>
      </div>

      {/* End-user authentication */}
      <div className="card-pad">
        <SectionHeader
          title="End-user authentication"
          sub="How callers prove themselves to this connector."
        />
        <div className="space-y-3">
          {ENDUSER_AUTH_OPTIONS.map((opt) => (
            <div key={opt.id} className={`rounded-xl border p-4 ${opt.disabled ? 'border-white/10 opacity-60' : 'border-white/10'}`}>
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-medium text-slate-100">{opt.label}</h3>
                {opt.disabled
                  ? <span className="badge badge-gray !text-[10px] ml-auto">Demo: disabled</span>
                  : <span className="badge badge-blue !text-[10px] ml-auto">Active method</span>}
              </div>
              <p className="text-xs text-slate-500 mt-1.5 leading-relaxed">{opt.desc}</p>
              {opt.disabled && opt.disabledNote && (
                <p className="text-xs text-amber-300/90 mt-1.5">{opt.disabledNote}</p>
              )}
              {!opt.disabled && (
                <Link to="/operate" className="btn-secondary btn-sm mt-3 inline-flex items-center gap-1.5">
                  <KeyRound size={14} /> Manage gateway keys in Operate
                </Link>
              )}
            </div>
          ))}
        </div>
      </div>

      {project.toolsTotal === 0 && (
        <EmptyState
          title="No tools yet"
          sub="Import an API spec first — each operation becomes one tool draft."
          action={<Link to="/import" className="btn-secondary btn-sm">Go to Import</Link>}
        />
      )}
    </div>
  );
}
