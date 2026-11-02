import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowRight, Check, FolderPlus, Rocket, Trash2 } from 'lucide-react';
import { useActiveProject, useFoundryStore } from '../../app/store';
import { canCreateProject, accessForProject } from '../../data/permissions';
import { formatTargets, statusLabel, statusTone } from '../../data/projects';
import type { ConnectorTarget, ProjectSummary } from '../../data/projects';
import { deleteProject, listProjects, mapBackendProject, updateProjectTargets } from '../../data/api';
import TargetEditor from './TargetEditor';
import { Badge, EmptyState, ErrorState, SectionHeader } from '../../shared/components/atoms';
import { cn } from '../../shared/lib/utils';

export default function ProjectsPage() {
  const navigate = useNavigate();
  // FE-09: project creation and target edits follow the caller's role.
  const me = useFoundryStore((s) => s.me);
  const canCreate = canCreateProject(me);
  const projects = useFoundryStore((s) => s.projects);
  const setProjects = useFoundryStore((s) => s.setProjects);
  const activeProject = useActiveProject();
  const activeProjectId = activeProject?.id ?? null;
  const setActiveProject = useFoundryStore((s) => s.setActiveProject);
  const updateProject = useFoundryStore((s) => s.updateProject);
  const removeProject = useFoundryStore((s) => s.removeProject);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftTargets, setDraftTargets] = useState<ConnectorTarget[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  /** Two-step delete: first click arms, second click deletes. No undo. */
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<{ id: string; msg: string } | null>(null);

  // The registry is real data: fetch the caller's projects from the API on every visit.
  const refresh = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const { projects: rows } = await listProjects();
      setProjects(rows.map(mapBackendProject));
    } catch (e: any) {
      setLoadError(e.message ?? String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { refresh(); }, []);

  const startEdit = (p: ProjectSummary) => {
    setEditingId(p.id);
    setDraftTargets(p.targets);
    setSaveError(null);
  };
  const cancelEdit = () => setEditingId(null);
  const toggleDraft = (id: ConnectorTarget) =>
    setDraftTargets((ts) => (ts.includes(id) ? ts.filter((t) => t !== id) : [...ts, id]));
  const saveEdit = async (id: string) => {
    if (draftTargets.length === 0 || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      await updateProjectTargets(id, draftTargets);
      updateProject(id, { targets: draftTargets });
      setEditingId(null);
    } catch (e: any) {
      setSaveError(e.message ?? String(e));
    } finally {
      setSaving(false);
    }
  };

  const openProject = (id: string) => {
    setActiveProject(id);
    navigate('/dashboard');
  };

  const onDelete = async (p: ProjectSummary) => {
    if (confirmingDeleteId !== p.id) {
      setConfirmingDeleteId(p.id);
      setDeleteError(null);
      return;
    }
    setDeletingId(p.id);
    setDeleteError(null);
    try {
      await deleteProject(p.id);
      setConfirmingDeleteId(null);
      removeProject(p.id);
    } catch (e: any) {
      setDeleteError({ id: p.id, msg: e.message ?? String(e) });
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="page-title">Projects</h1>
          <p className="page-sub">
            Every source API you are turning into an agent connector. Pick one to open its command center.
          </p>
        </div>
        {canCreate && (
        <button onClick={() => navigate('/projects/new')} className="btn-primary btn-sm">
          <FolderPlus size={14} /> New project
        </button>
        )}
      </div>

      {loading ? (
        <div className="grid md:grid-cols-2 gap-4">
          {[0, 1].map((i) => (
            <div key={i} className="card p-5 space-y-3 animate-pulse">
              <div className="h-5 w-2/3 rounded bg-white/10" />
              <div className="h-3 w-1/3 rounded bg-white/5" />
              <div className="h-16 rounded bg-white/5" />
            </div>
          ))}
        </div>
      ) : loadError ? (
        <ErrorState
          message={`Couldn't load your projects: ${loadError}`}
          hint="Is the backend running? (projects/connector-foundry/backend/server ./dev.sh)"
          onRetry={refresh}
        />
      ) : projects.length === 0 ? (
        <EmptyState
          title="No projects yet — create your first one."
          sub="Bring your API and we'll turn it into a tested, reliable agent connector."
          action={
            canCreate ? (
            <div className="flex items-center justify-center gap-3">
              <button onClick={() => navigate('/onboarding')} className="btn-primary btn-sm">
                <Rocket size={14} /> Start the guided tour
              </button>
              <button onClick={() => navigate('/projects/new')} className="btn-ghost btn-sm">
                <FolderPlus size={14} /> New project
              </button>
            </div>
            ) : undefined
          }
        />
      ) : (
        <>
          <SectionHeader index="01 · Registry" title="All projects" hint={`${projects.length} PROJECTS`} />

          <div className="grid md:grid-cols-2 gap-4">
            {projects.map((p) => {
          const isActive = p.id === activeProjectId;
          // FE-09: target edits are a project mutation (PATCH /:id).
          const pAccess = accessForProject(me, p);
          return (
            <div
              key={p.id}
              className={cn(
                'card panel-glow p-5 flex flex-col gap-4 transition-colors',
                isActive && 'border-neon/40 shadow-glow',
              )}
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <Link
                      to={`/projects/${p.id}`}
                      className="font-display text-lg font-semibold text-white hover:text-neon hover:underline"
                      title="Open project details — targets, authentication, end-user access"
                    >
                      {p.name}
                    </Link>
                    {isActive && (
                      <span className="badge badge-blue !text-[10px]">
                        <Check size={12} /> Active
                      </span>
                    )}
                    {p.customerName && (
                      <span className="text-[11px] text-slate-500">{p.customerName}</span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs text-slate-500 font-mono mt-1">→ {formatTargets(p.targets)}</span>
                    {editingId === p.id ? (
                      <button onClick={cancelEdit} className="text-[11px] text-slate-500 hover:text-slate-300">
                        Cancel
                      </button>
                    ) : pAccess.canEdit ? (
                      <button onClick={() => startEdit(p)} className="text-[11px] text-neon hover:underline">
                        Edit targets
                      </button>
                    ) : null}
                  </div>
                </div>
                <Badge tone={statusTone[p.status]}>{statusLabel[p.status]}</Badge>
              </div>

              {editingId === p.id && (
                <>
                  <TargetEditor
                    project={p}
                    draft={draftTargets}
                    onToggle={toggleDraft}
                    onSave={() => saveEdit(p.id)}
                    busy={saving}
                  />
                  {saveError && <div className="text-xs text-red-300">{saveError}</div>}
                </>
              )}

              <p className="text-sm text-slate-400">{p.blurb}</p>

              <div className="grid grid-cols-3 gap-3">
                <div className="rounded-lg bg-white/5 border border-white/10 px-3 py-2.5">
                  <div className="micro-label">Tools</div>
                  <div className="font-display text-xl text-white mt-0.5">
                    {p.toolsApproved}<span className="text-slate-500 text-sm">/{p.toolsTotal}</span>
                  </div>
                </div>
                <div className="rounded-lg bg-white/5 border border-white/10 px-3 py-2.5">
                  <div className="micro-label">Eval pass</div>
                  <div className="font-display text-xl text-white mt-0.5">
                    {p.evalPassRate === null ? '—' : `${p.evalPassRate}%`}
                  </div>
                  <div className="text-[11px] text-slate-500">{p.evalSummary}</div>
                </div>
                <div className="rounded-lg bg-white/5 border border-white/10 px-3 py-2.5">
                  <div className="micro-label">Blockers</div>
                  <div className={cn('font-display text-xl mt-0.5', p.blockerCount > 0 ? 'text-red-300' : 'text-emerald-300')}>
                    {p.blockerCount}
                  </div>
                  <div className="text-[11px] text-slate-500">{p.openQuestions} questions</div>
                </div>
              </div>

              <div className="flex items-center justify-between mt-auto pt-1">
                <span className="text-xs text-slate-500 font-mono">
                  {p.version} · updated {p.updatedAt}
                </span>
                <div className="flex items-center gap-2">
                  {pAccess.canDeleteProject && (
                    <button
                      onClick={() => onDelete(p)}
                      disabled={deletingId === p.id}
                      title={pAccess.ownerOnlyReason ?? 'Permanently delete this project and everything it owns. No undo.'}
                      className={confirmingDeleteId === p.id
                        ? 'btn-sm rounded-md bg-red-500/20 border border-red-400/40 text-red-200 hover:bg-red-500/30 disabled:opacity-40 px-3 py-1.5 text-xs font-medium'
                        : 'btn-sm rounded-md border border-white/10 text-slate-500 hover:text-red-300 hover:border-red-400/30 disabled:opacity-40 px-3 py-1.5 text-xs font-medium'}
                    >
                      <Trash2 size={14} />{' '}
                      {deletingId === p.id ? 'Deleting…' : confirmingDeleteId === p.id ? 'Confirm delete?' : 'Delete'}
                    </button>
                  )}
                  <button
                    onClick={() => openProject(p.id)}
                    className={isActive ? 'btn-secondary btn-sm' : 'btn-primary btn-sm'}
                  >
                    {isActive ? 'Open command center' : 'Switch to project'} <ArrowRight size={14} />
                  </button>
                </div>
              </div>
              {deleteError?.id === p.id && (
                <div className="text-xs text-red-300">Couldn&apos;t delete: {deleteError.msg}</div>
              )}
            </div>
          );
        })}
          </div>
        </>
      )}


    </div>
  );
}
