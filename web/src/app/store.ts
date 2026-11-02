import { create } from 'zustand';
import type { AgentTool, EvalRun, Finding, Operation } from '../data/types';
import type { ProjectSummary } from '../data/projects';
import {
  api, createRelease, approveRelease, promoteRelease, fetchTelemetry, getEvalRun, getReleaseManifest, listEvalRuns,
  listProjects, listReleases, listReviewItems, mapBackendEvalRun, mapBackendProject, mapReviewFinding,
  mapTool, pollJob, enqueueCompile, enqueueEval, withBackendId,
} from '../data/api';
import type { Telemetry, Me } from '../data/api';
import { accessForProject, type WorkspaceAccess } from '../data/permissions';

// ─── Foundry store ───────────────────────────────────────────────────────────
// The service boundary the UI talks to. Everything comes from the control-plane
// API (D-87: no mock dataset, no demo project): the project registry from
// GET /v1/projects, and the active project's operations, tools, review items,
// latest eval run and latest release from its own endpoints.

const ACTIVE_KEY = 'cf-active-project';

function storedActiveProject(): string | null {
  try { return localStorage.getItem(ACTIVE_KEY); } catch { return null; }
}

export interface LiveRelease {
  id: string;
  version: string;
  manifest: any;
  channel: 'staging' | 'prod';
}

interface FoundryState {
  /** FE-09/FE-13: the signed-in identity from /v1/me, loaded once by the
   *  Layout — pages derive role-gated UI from it (data/permissions). */
  me: Me | null;
  setMe: (me: Me | null) => void;

  /** Project registry (GET /v1/projects). */
  projects: ProjectSummary[];
  projectsLoaded: boolean;
  loadProjects: () => Promise<void>;
  addProject: (p: ProjectSummary) => void;
  setProjects: (projects: ProjectSummary[]) => void;
  updateProject: (id: string, patch: Partial<ProjectSummary>) => void;
  removeProject: (id: string) => void;

  /** The project every build screen is scoped to; null until one exists. */
  activeProjectId: string | null;
  setActiveProject: (id: string) => void;

  // The active project's data (loadProject).
  operations: Operation[];
  tools: AgentTool[];
  findings: Finding[];
  evalRun: EvalRun | null;
  release: LiveRelease | null;
  telemetry: Telemetry | null;
  toolBackendIds: Record<string, string>;
  busy: boolean;
  /** True while a release cut or prod promotion is in flight (Publish). */
  publishing: boolean;
  error: string | null;

  loadProject: (id?: string) => Promise<void>;
  compile: () => Promise<void>;
  runEval: () => Promise<void>;
  createRelease: (version: string) => Promise<void>;
  /** RL-07: promote the release from staging to prod. */
  promoteRelease: () => Promise<void>;
  loadTelemetry: () => Promise<void>;

  approveTool: (name: string) => void;
  excludeTool: (name: string, reason: string) => void;
  reopenTool: (name: string) => void;
  updateTool: (name: string, patch: Partial<AgentTool>) => void;
  resolveFinding: (id: string) => void;
  acknowledgeFinding: (id: string) => void;
  /** Bulk: resolve/acknowledge many review items at once (review queue). */
  resolveFindings: (ids: string[]) => void;
  acknowledgeFindings: (ids: string[]) => void;
  /** Bulk: approve many tools at once (tools table). Names without a backend id are skipped. */
  approveTools: (names: string[]) => void;
}

const message = (e: unknown) => String(e instanceof Error ? e.message : e);

const emptyProjectData = {
  operations: [], tools: [], findings: [], evalRun: null, release: null, telemetry: null,
  toolBackendIds: {},
};

export const useFoundryStore = create<FoundryState>((set, get) => {
  /** Reload the active project's tools (status changes after compile / eval / approval). */
  const reloadTools = async (projectId: string) => {
    // The server caps a single response at 100 rows (BE-08: bounded pages —
    // the tools read also fans out to recovery rules per tool), so the full
    // set loads by following cursor pages, not by raising the limit. Review
    // deep-links plus the tool table need every tool, not just the first page.
    const all: any[] = [];
    let cursor: string | null = null;
    // A stuck cursor must never spin forever: 100 pages (10k tools) is far
    // past any real project, and has_more=false ends the loop long before.
    for (let page = 0; page < 100; page++) {
      const qs: string = cursor ? `?limit=100&cursor=${encodeURIComponent(cursor)}` : '?limit=100';
      const res: {
        tools: any[];
        pagination: { next_cursor: string | null; has_more: boolean };
      } = await api(`/v1/projects/${projectId}/tools${qs}`);
      all.push(...res.tools);
      if (!res.pagination?.has_more || !res.pagination.next_cursor) break;
      cursor = res.pagination.next_cursor;
    }
    const ids: Record<string, string> = {};
    const mapped = all.map((t) => {
      ids[t.name] = t.id;
      return withBackendId(mapTool(t), t.id);
    });
    if (get().activeProjectId === projectId) set({ tools: mapped, toolBackendIds: ids });
  };

  /** Run a mutating action with the busy / error flags; rethrows so callers can react. */
  const withBusy = async (fn: (projectId: string) => Promise<void>) => {
    const projectId = get().activeProjectId;
    if (!projectId) throw new Error('No project selected.');
    set({ busy: true, error: null });
    try {
      await fn(projectId);
      set({ busy: false });
    } catch (e) {
      set({ busy: false, error: message(e) });
      throw e;
    }
  };

  const patchTool = (name: string, status: 'approved' | 'candidate') => {
    const { activeProjectId, toolBackendIds } = get();
    const id = toolBackendIds[name];
    if (!activeProjectId || !id) return;
    api(`/v1/projects/tools/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) })
      .then(() => reloadTools(activeProjectId))
      .catch((e) => set({ error: message(e) }));
  };

  return {
    me: null,
    setMe: (me) => set({ me }),

    projects: [],
    projectsLoaded: false,
    loadProjects: async () => {
      try {
        const { projects } = await listProjects();
        get().setProjects(projects.map(mapBackendProject));
      } catch (e) {
        set({ error: message(e) });
      } finally {
        set({ projectsLoaded: true });
      }
    },
    addProject: (p) => {
      set((s) => ({ projects: [...s.projects.filter((x) => x.id !== p.id), p] }));
      get().setActiveProject(p.id);
    },
    setProjects: (projects) => {
      const { activeProjectId } = get();
      const keep = projects.find((p) => p.id === activeProjectId)?.id
        ?? projects.find((p) => p.id === storedActiveProject())?.id
        ?? projects[0]?.id
        ?? null;
      set({ projects });
      if (keep !== activeProjectId) {
        if (keep) get().setActiveProject(keep);
        else set({ activeProjectId: null, ...emptyProjectData });
      }
    },
    updateProject: (id, patch) =>
      set((s) => ({
        projects: s.projects.map((p) => (p.id === id ? { ...p, ...patch, id: p.id } : p)),
      })),
    removeProject: (id) => {
      // setProjects re-homes the active project (next project, or cleared data).
      get().setProjects(get().projects.filter((p) => p.id !== id));
    },

    activeProjectId: null,
    setActiveProject: (id) => {
      try { localStorage.setItem(ACTIVE_KEY, id); } catch { /* per-viewer convenience only */ }
      set({ activeProjectId: id, error: null, ...emptyProjectData });
      void get().loadProject(id);
    },

    ...emptyProjectData,
    busy: false,
    publishing: false,
    error: null,

    loadProject: async (id) => {
      const projectId = id ?? get().activeProjectId;
      if (!projectId) return;
      try {
        const [ops, review, runs, releases] = await Promise.all([
          api<{ operations: any[] }>(`/v1/projects/${projectId}/operations`),
          listReviewItems(projectId),
          listEvalRuns(projectId),
          listReleases(projectId),
        ]);
        await reloadTools(projectId);
        let evalRun: EvalRun | null = null;
        if (runs.runs.length > 0) {
          const { run, results } = await getEvalRun(runs.runs[0].id);
          evalRun = mapBackendEvalRun(run, results);
        }
        const latest = releases.releases[0];
        const manifest = latest ? await getReleaseManifest(latest.id) : null;
        if (get().activeProjectId !== projectId) return;
        set({
          operations: ops.operations.map((op, i) => ({
            fingerprint: `${op.http_method ?? op.method} ${op.path}#${i}`,
            method: (op.http_method ?? op.method) as Operation['method'],
            path: op.path,
            summary: op.summary ?? '',
            effect: op.effect ?? 'UNKNOWN',
            docScore: op.doc_score ?? 0,
            schemaComplexity: 'low' as const,
            authScheme: op.auth_scheme ?? 'none',
            deprecated: Boolean(op.deprecated),
            recommendation: (op.effect ?? 'READ') === 'READ' ? 'include' as const : 'review' as const,
            userJobs: [],
          })),
          findings: review.review_items.map(mapReviewFinding),
          evalRun,
          release: latest
            ? { id: latest.id, version: latest.version, manifest, channel: latest.channel === 'prod' ? 'prod' : 'staging' }
            : null,
        });
      } catch (e) {
        if (get().activeProjectId === projectId) set({ error: message(e) });
      }
    },

    compile: () => withBusy(async (projectId) => {
      const { job } = await enqueueCompile(projectId);
      const done = await pollJob(job.id);
      if (done.status !== 'succeeded') throw new Error(done.error ?? 'Compile job failed');
      await get().loadProject(projectId);
    }),

    runEval: () => withBusy(async (projectId) => {
      const { job } = await enqueueEval(projectId);
      const done = await pollJob(job.id);
      if (done.status !== 'succeeded') throw new Error(done.error ?? 'Evaluation job failed');
      const runId = (done.result as any)?.run_id as string | undefined;
      if (!runId) throw new Error('Evaluation finished without a run id');
      const { run, results } = await getEvalRun(runId);
      set({ evalRun: mapBackendEvalRun(run, results) });
      await reloadTools(projectId);
    }),

    createRelease: (version) => {
      set({ publishing: true });
      return withBusy(async (projectId) => {
        const rel = await createRelease(projectId, version);
        await approveRelease(rel.release_id);
        // RL-07: a fresh release is approved into the staging channel; prod
        // only changes on an explicit promotion.
        set({ release: { id: rel.release_id, version: rel.version, manifest: rel.manifest, channel: 'staging' } });
      }).finally(() => set({ publishing: false }));
    },

    promoteRelease: () => {
      set({ publishing: true });
      return withBusy(async () => {
        const { release } = get();
        if (!release) throw new Error('No release yet.');
        await promoteRelease(release.id, 'prod');
        set({ release: { ...release, channel: 'prod' } });
      }).finally(() => set({ publishing: false }));
    },

    loadTelemetry: async () => {
      const projectId = get().activeProjectId;
      if (!projectId) return;
      try {
        const telemetry = await fetchTelemetry(projectId);
        if (get().activeProjectId === projectId) set({ telemetry });
      } catch (e) {
        set({ error: message(e) });
      }
    },

    approveTool: (name) => {
      set((s) => ({ tools: s.tools.map((t) => (t.name === name ? { ...t, status: 'approved' } : t)) }));
      patchTool(name, 'approved');
    },
    approveTools: (names) => {
      if (names.length === 0) return;
      const { activeProjectId, toolBackendIds } = get();
      if (!activeProjectId) return;
      const wanted = new Set(names);
      set((s) => ({ tools: s.tools.map((t) => (wanted.has(t.name) ? { ...t, status: 'approved' } : t)) }));
      const ids = names.map((n) => toolBackendIds[n]).filter((id): id is string => !!id);
      Promise.all(ids.map((id) =>
        api(`/v1/projects/tools/${id}`, { method: 'PATCH', body: JSON.stringify({ status: 'approved' }) }),
      ))
        .then(() => reloadTools(activeProjectId))
        .catch((e) => set({ error: message(e) }));
    },
    // The API has no "excluded" status: an excluded tool is a candidate that is
    // never approved, so it stays out of every release. The reason is shown in
    // this session only.
    excludeTool: (name, reason) => {
      set((s) => ({
        tools: s.tools.map((t) => (t.name === name ? { ...t, status: 'excluded', excludeReason: reason } : t)),
      }));
      patchTool(name, 'candidate');
    },
    reopenTool: (name) => {
      set((s) => ({
        tools: s.tools.map((t) => (t.name === name ? { ...t, status: 'needs_review', excludeReason: undefined } : t)),
      }));
      patchTool(name, 'candidate');
    },
    // Persist tool edits (description, effect class, confirmation rule) to the
    // backend — local-only edits would silently vanish on refresh.
    updateTool: (name, patch) => {
      set((s) => ({ tools: s.tools.map((t) => (t.name === name ? { ...t, ...patch } : t)) }));
      const { activeProjectId, toolBackendIds } = get();
      const id = toolBackendIds[name];
      if (!activeProjectId || !id) return;
      const body: Record<string, unknown> = {};
      if (patch.description !== undefined) body.description = patch.description;
      if ((patch as { intent?: string }).intent !== undefined) {
        body.purpose = (patch as { intent?: string }).intent;
      }
      if (patch.effect !== undefined) {
        const cls = { READ: 'read_only', WRITE: 'mutating', DESTRUCTIVE: 'destructive' } as const;
        const mapped = cls[patch.effect as keyof typeof cls];
        if (mapped) body.effect_classes = [mapped];
      }
      if (patch.confirmation !== undefined) body.confirmation_required = patch.confirmation === 'ALWAYS';
      if (Object.keys(body).length === 0) return;
      api(`/v1/projects/tools/${id}`, { method: 'PATCH', body: JSON.stringify(body) })
        .then(() => reloadTools(activeProjectId))
        .catch((e) => set({ error: message(e) }));
    },

    resolveFinding: (id) => {
      set((s) => ({ findings: s.findings.map((f) => (f.id === id ? { ...f, status: 'resolved' } : f)) }));
      api(`/v1/projects/review/${id}`, { method: 'PATCH', body: JSON.stringify({ status: 'resolved' }) })
        .catch((e) => set({ error: message(e) }));
    },
    acknowledgeFinding: (id) => {
      set((s) => ({ findings: s.findings.map((f) => (f.id === id ? { ...f, status: 'acknowledged' } : f)) }));
      api(`/v1/projects/review/${id}`, { method: 'PATCH', body: JSON.stringify({ status: 'acknowledged' }) })
        .catch((e) => set({ error: message(e) }));
    },
    resolveFindings: (ids) => {
      if (ids.length === 0) return;
      const wanted = new Set(ids);
      set((s) => ({ findings: s.findings.map((f) => (wanted.has(f.id) ? { ...f, status: 'resolved' } : f)) }));
      Promise.all(ids.map((id) =>
        api(`/v1/projects/review/${id}`, { method: 'PATCH', body: JSON.stringify({ status: 'resolved' }) }),
      )).catch((e) => set({ error: message(e) }));
    },
    acknowledgeFindings: (ids) => {
      if (ids.length === 0) return;
      const wanted = new Set(ids);
      set((s) => ({ findings: s.findings.map((f) => (wanted.has(f.id) ? { ...f, status: 'acknowledged' } : f)) }));
      Promise.all(ids.map((id) =>
        api(`/v1/projects/review/${id}`, { method: 'PATCH', body: JSON.stringify({ status: 'acknowledged' }) }),
      )).catch((e) => set({ error: message(e) }));
    },
  };
});

// ─── Derived selectors ───────────────────────────────────────────────────────

/** The active project, or null before the first project exists. */
export function useActiveProject(): ProjectSummary | null {
  const projects = useFoundryStore((s) => s.projects);
  const activeProjectId = useFoundryStore((s) => s.activeProjectId);
  return projects.find((p) => p.id === activeProjectId) ?? null;
}

/**
 * FE-09: what the signed-in user may do in the active project's workspace
 * (see data/permissions for the BE-13 matrix). Pages disable mutation
 * controls with `access.readOnlyReason` instead of leading viewers into
 * a 403; the API remains the real gate.
 */
export function useProjectAccess(): WorkspaceAccess {
  const me = useFoundryStore((s) => s.me);
  const project = useActiveProject();
  return accessForProject(me, project);
}

export function useReadiness() {
  const tools = useFoundryStore((s) => s.tools);
  const findings = useFoundryStore((s) => s.findings);

  const openBlockers = findings.filter((f) => f.severity === 'blocker' && f.status === 'open');
  const openWarnings = findings.filter((f) => f.severity === 'warning' && f.status === 'open');
  const needsReview = tools.filter((t) => t.status === 'needs_review');
  const approved = tools.filter((t) => t.status === 'approved');

  const blockerCount = openBlockers.length + needsReview.length;

  return { openBlockers, openWarnings, needsReview, approved, blockerCount, tools, findings };
}
