import { useEffect, useState } from 'react';
import type { ChangeEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft, ArrowRight, BookOpen, Bot, Check, Cpu, FileText, Link2, Loader2, Sparkles, Upload,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useFoundryStore } from '../../app/store';
import type { ConnectorTarget, ProjectSummary, UpstreamAuthMode } from '../../data/projects';
import { TARGET_OPTIONS, formatTargets } from '../../data/projects';
import UpstreamAuthFields from './UpstreamAuthFields';
import {
  ApiError, createProject, getMe, importSource, mapBackendProject, saveCredential,
  type Usage, type WorkspaceMembership,
  getUsage,
} from '../../data/api';
import { planForMembership, projectCapMessage, projectMeter, type WorkspacePlan } from '../../data/plan';
import { KvRow, ProgressBar } from '../../shared/components/atoms';
import { cn } from '../../shared/lib/utils';

// ─── Wizard model ────────────────────────────────────────────────────────────

type SourceKind = 'openapi-url' | 'upload' | 'postman' | 'docs';

interface SourceMethod {
  id: SourceKind;
  title: string;
  desc: string;
  badge?: string;
  input: 'url' | 'file';
  placeholder?: string;
  note?: string;
  icon: LucideIcon;
}

const SOURCE_METHODS: SourceMethod[] = [
  {
    id: 'openapi-url',
    title: 'OpenAPI 3.x URL',
    desc: 'Point us at your spec — the fastest path.',
    badge: 'Recommended',
    input: 'url',
    placeholder: 'https://api.example.com/openapi.json',
    icon: Link2,
  },
  {
    id: 'upload',
    title: 'Upload a spec file',
    desc: 'OpenAPI or Swagger JSON / YAML from your machine.',
    input: 'file',
    icon: Upload,
  },
  {
    id: 'postman',
    title: 'Postman collection',
    desc: 'We normalize collections into the same canonical model.',
    input: 'url',
    placeholder: 'https://api.example.com/collection.json',
    icon: FileText,
  },
  {
    id: 'docs',
    title: 'Docs URL',
    desc: 'No machine-readable spec? We map it with guided sandbox probing.',
    input: 'url',
    placeholder: 'https://docs.example.com/api-reference',
    note: 'Bring what you have — we normalize it.',
    icon: BookOpen,
  },
];

const STEPS = ['Project details', 'Bring your API', 'Target connector', 'Upstream auth', 'Review'];

const stepValid = (
  step: number,
  name: string,
  method: SourceMethod,
  url: string,
  fileName: string,
  targets: ConnectorTarget[],
) => {
  if (step === 0) return name.trim().length > 0;
  if (step === 1) return method.input === 'file' ? fileName.length > 0 : url.trim().length > 0;
  if (step === 2) return targets.length > 0;
  // Upstream auth is optional at creation — a missing key can be saved later
  // from the project detail page. The access-token method is disabled anyway.
  return true;
};

const TARGET_ICONS: Record<ConnectorTarget, LucideIcon> = {
  mcp: Bot,
  openai: Sparkles,
  muse: Cpu,
};

// ─── Page ────────────────────────────────────────────────────────────────────

export default function NewProjectPage() {
  const navigate = useNavigate();
  const addProject = useFoundryStore((s) => s.addProject);

  const [step, setStep] = useState(0);
  const [phase, setPhase] = useState<'idle' | 'creating' | 'importing'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [savedProject, setSavedProject] = useState<ProjectSummary | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [methodId, setMethodId] = useState<SourceKind>('openapi-url');
  const [url, setUrl] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [fileName, setFileName] = useState('');
  const [targets, setTargets] = useState<ConnectorTarget[]>(['mcp', 'openai', 'muse']);
  const [authMode, setAuthMode] = useState<UpstreamAuthMode>('api_key');
  const [apiKey, setApiKey] = useState('');
  const [loginUri, setLoginUri] = useState('');

  // Workspaces the caller can create projects in (from /v1/me).
  const [memberships, setMemberships] = useState<WorkspaceMembership[]>([]);
  const [customerId, setCustomerId] = useState<string>('');
  const [meError, setMeError] = useState<string | null>(null);
  const [meLoading, setMeLoading] = useState(true);

  // FE-03: project usage for the selected workspace, so the wizard can show
  // the plan meter and the designed at-cap state. Fails silent when usage can't load.
  const [usage, setUsage] = useState<Usage | null>(null);
  /** The at-cap blocked state — usage as the server reported it, or null. */
  const [capBlocked, setCapBlocked] = useState<Usage | null>(null);

  useEffect(() => {
    getMe()
      .then(({ memberships: ms }) => {
        const writable = ms.filter((m) => m.writable);
        setMemberships(writable);
        if (writable.length > 0) setCustomerId(writable[0].customer_id);
      })
      .catch((e: any) => setMeError(e.message ?? String(e)))
      .finally(() => setMeLoading(false));
  }, []);

  useEffect(() => {
    if (!customerId) { setUsage(null); return; }
    setCapBlocked(null);
    getUsage(customerId)
      .then(setUsage)
      .catch(() => setUsage(null));
  }, [customerId]);

  const selectedMembership = memberships.find((m) => m.customer_id === customerId) ?? null;
  const selectedPlan: WorkspacePlan | null = selectedMembership ? planForMembership(selectedMembership) : null;
  const atCap = usage !== null && usage.projects_used >= usage.project_cap;

  const method = SOURCE_METHODS.find((m) => m.id === methodId) ?? SOURCE_METHODS[0];
  const valid = stepValid(step, name, method, url, fileName, targets) && customerId.length > 0;
  const working = phase !== 'idle';

  const toggleTarget = (id: ConnectorTarget) =>
    setTargets((ts) => (ts.includes(id) ? ts.filter((t) => t !== id) : [...ts, id]));

  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0] ?? null;
    setFile(f);
    setFileName(f ? f.name : '');
  };

  const needsImport = methodId === 'openapi-url' || methodId === 'upload' || methodId === 'postman';

  const create = async () => {
    setError(null);
    setCapBlocked(null);
    let saved: ProjectSummary | null = null;
    try {
      // 1. Save the project — this is the real registry row in PostgreSQL.
      setPhase('creating');
      const { project } = await createProject({
        name: name.trim(),
        description: description.trim() || undefined,
        targets,
        customer_id: customerId,
      });
      saved = mapBackendProject(project);
      setSavedProject(saved);

      // 2. Save the upstream API key when one was provided — it belongs to
      //    the project (vault), not to any tool screen.
      if (authMode === 'api_key' && apiKey.trim().length > 0) {
        try {
          await saveCredential(project.id, 'default', apiKey.trim());
        } catch (e: any) {
          // Non-fatal: the project exists and the key can be saved later
          // from the project detail page — say so instead of failing create.
          setError(`Project "${name.trim()}" was saved, but the API key wasn't: ${e.message ?? String(e)}. Add it from the project detail page.`);
        }
      }

      // 3. Import the spec for real (fetch + parse + store operations).
      //    Postman collections normalize through the same path (IA-02);
      //    bare docs URLs don't have a normalizer yet — for those the
      //    project is saved and import arrives with IA-03.
      if (needsImport) {
        setPhase('importing');
        const payload =
          methodId === 'openapi-url' || methodId === 'postman' ? url.trim() : await (file as File).text();
        await importSource(
          project.id,
          methodId === 'openapi-url' ? 'openapi_url'
            : methodId === 'postman' ? 'postman_url'
            : 'openapi_text',
          payload,
        );
        // Refresh the summary so the list shows the imported state.
        saved = { ...saved, status: 'in_review', sourceDetail: methodId === 'openapi-url' ? url.trim() : fileName };
        setSavedProject(saved);
      }

      addProject(saved); // also makes it the active project
      navigate('/projects');
    } catch (e: any) {
      // If the project row was saved but the import blew up, the project
      // still exists — surface it and let the user continue.
      const msg = e.message ?? String(e);
      // FE-03: the server enforces the project cap with a 409
      // `project_limit_reached` — render the designed blocked state with the
      // upgrade nudge, not a raw error string. The 409 body carries the cap
      // context; prefer it over the (possibly stale) meter.
      if (e instanceof ApiError && e.code === 'project_limit_reached') {
        const d = (e.details ?? {}) as { projects_used?: unknown; project_cap?: unknown };
        const used = Number(d.projects_used ?? usage?.projects_used ?? 0);
        const cap = Number(d.project_cap ?? usage?.project_cap ?? selectedPlan?.projectCap ?? 0);
        setCapBlocked({
          seats_used: 0, seat_cap: 0, seat_override: null, plan_seat_cap: 0,
          projects_used: Number.isFinite(used) ? used : 0,
          project_cap: Number.isFinite(cap) && cap > 0 ? cap : (selectedPlan?.projectCap ?? 0),
        });
        setError(null);
      } else {
        setError(saved ? `Project "${saved.name}" was saved, but the import failed: ${msg}` : msg);
      }
      setPhase('idle');
    }
  };

  const continueToProjects = () => {
    if (savedProject) addProject(savedProject);
    navigate('/projects');
  };

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div>
        <h1 className="page-title">New project</h1>
        <p className="page-sub">Turn a REST API into a tested, reliable agent connector.</p>
      </div>

      {/* Stepper */}
      <div className="flex items-center">
        {STEPS.map((label, i) => (
          <div key={label} className="flex items-center flex-1 last:flex-none">
            <div className="flex flex-col items-center gap-1.5 shrink-0">
              <span
                className={cn(
                  'w-8 h-8 rounded-full flex items-center justify-center text-sm font-semibold border transition-colors',
                  i < step
                    ? 'bg-emerald-400/15 border-emerald-400/40 text-emerald-300'
                    : i === step
                      ? 'bg-neon/15 border-neon/50 text-neon shadow-glow'
                      : 'bg-white/5 border-white/10 text-slate-500',
                )}
              >
                {i < step ? <Check size={15} /> : i + 1}
              </span>
              <span className={cn('text-[11px] whitespace-nowrap', i === step ? 'text-slate-200' : 'text-slate-500')}>
                {label}
              </span>
            </div>
            {i < STEPS.length - 1 && (
              <div className={cn('flex-1 h-px mx-2 mb-5', i < step ? 'bg-emerald-400/40' : 'bg-white/10')} />
            )}
          </div>
        ))}
      </div>

      <div className="card panel-glow p-6 min-h-[380px]">
        {!working && capBlocked && (
          <div className="mb-5 rounded-xl border border-amber-400/30 bg-amber-400/10 p-4 text-sm">
            <div className="font-medium text-amber-200 mb-1">Project limit reached</div>
            <div className="text-slate-300 leading-relaxed">
              {selectedPlan ? projectCapMessage(selectedPlan, capBlocked) : 'Project limit reached for this workspace.'}
            </div>
            <button onClick={() => navigate('/projects')} className="btn-secondary btn-sm mt-3">
              Back to projects <ArrowRight size={14} />
            </button>
          </div>
        )}
        {!working && error && (
          <div className="mb-5 rounded-xl border border-red-400/30 bg-red-400/10 p-4 text-sm text-red-200">
            <div>{error}</div>
            {savedProject && (
              <button onClick={continueToProjects} className="btn-secondary btn-sm mt-3">
                Continue to projects <ArrowRight size={14} />
              </button>
            )}
          </div>
        )}
        {working ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <Loader2 size={32} className="text-neon animate-spin" />
            <div className="font-display text-lg text-white mt-5">
              {phase === 'creating' ? 'Saving your project…' : 'Importing your API…'}
            </div>
            <p className="text-sm text-slate-400 mt-2 max-w-sm">
              {phase === 'creating'
                ? 'Writing the project to your workspace registry.'
                : 'Fetching the spec, mapping operations into the canonical model, and storing the import.'}
            </p>
            <div className="w-64 max-w-full mt-6">
              <ProgressBar value={100} tone="brand" />
            </div>
          </div>
        ) : (
          <>
            {step === 0 && (
              <div className="space-y-4">
                <div>
                  <label className="label" htmlFor="proj-workspace">Workspace</label>
                  {meError ? (
                    <p className="text-xs text-red-300">Couldn't load your workspaces: {meError}</p>
                  ) : meLoading ? (
                    <p className="text-xs text-slate-500">Loading your workspaces…</p>
                  ) : memberships.length === 0 ? (
                    <div className="space-y-2">
                      <p className="text-xs text-amber-300">
                        You have no workspace you can create projects in yet.
                      </p>
                      {/* FE-07: no membership is no longer a dead end. */}
                      <button
                        type="button"
                        onClick={() => navigate('/organizations/new')}
                        className="btn-secondary btn-sm"
                      >
                        Create your organization <ArrowRight size={14} />
                      </button>
                    </div>
                  ) : memberships.length === 1 ? (
                    <p className="text-sm text-slate-300">
                      {memberships[0].customer_name}
                      <span className="text-slate-500 text-xs ml-2">{memberships[0].plan_name}</span>
                    </p>
                  ) : (
                    <select
                      id="proj-workspace"
                      className="input"
                      value={customerId}
                      onChange={(e) => setCustomerId(e.target.value)}
                    >
                      {memberships.map((m) => (
                        <option key={m.customer_id} value={m.customer_id}>
                          {m.customer_name} · {m.plan_name}
                        </option>
                      ))}
                    </select>
                  )}
                  {projectMeter(usage) && (
                    <p className="text-xs text-slate-500 mt-1.5">{projectMeter(usage)}</p>
                  )}
                </div>
                <div>
                  <label className="label" htmlFor="proj-name">Project name</label>
                  <input
                    id="proj-name"
                    className="input"
                    placeholder="e.g. Acme Billing API"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    autoFocus
                  />
                </div>
                <div>
                  <label className="label" htmlFor="proj-desc">
                    Description <span className="text-slate-500 font-normal">(optional)</span>
                  </label>
                  <textarea
                    id="proj-desc"
                    className="input min-h-[96px] resize-y"
                    placeholder="What does this API do? Who will use the connector?"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                  />
                </div>
              </div>
            )}

            {step === 1 && (
              <div className="space-y-3">
                <p className="text-sm text-slate-400">
                  Bring what you have — OpenAPI preferred, but we normalize Swagger, Postman collections, and
                  even bare docs URLs.
                </p>
                <div className="grid sm:grid-cols-2 gap-3">
                  {SOURCE_METHODS.map((m) => {
                    const selected = m.id === methodId;
                    return (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() => setMethodId(m.id)}
                        className={cn(
                          'text-left rounded-xl border p-4 transition-colors',
                          selected
                            ? 'border-neon bg-neon/10 ring-1 ring-neon'
                            : 'border-white/10 hover:border-white/20 hover:bg-white/5',
                        )}
                      >
                        <div className="flex items-center gap-2">
                          <m.icon size={17} className={selected ? 'text-neon' : 'text-slate-400'} />
                          <span className="text-sm font-medium text-slate-100">{m.title}</span>
                          {m.badge && (
                            <span className="badge badge-blue !text-[10px] ml-auto">{m.badge}</span>
                          )}
                        </div>
                        <p className="text-xs text-slate-500 mt-1.5 leading-relaxed">{m.desc}</p>
                      </button>
                    );
                  })}
                </div>

                {method.input === 'url' ? (
                  <div>
                    <label className="label" htmlFor="src-url">{method.title}</label>
                    <input
                      id="src-url"
                      className="input mono"
                      placeholder={method.placeholder}
                      value={url}
                      onChange={(e) => setUrl(e.target.value)}
                    />
                    {method.note && <p className="text-xs text-slate-500 mt-1.5">{method.note}</p>}
                  </div>
                ) : (
                  <div>
                    <label className="label">Spec file</label>
                    <label className="flex items-center justify-center gap-2 rounded-xl border border-dashed border-white/20 bg-white/5 px-4 py-8 cursor-pointer hover:border-neon/50 hover:bg-white/[0.07] transition-colors">
                      <Upload size={18} className="text-slate-400" />
                      <span className="text-sm text-slate-300">
                        {fileName ? <span className="mono text-neon">{fileName}</span> : 'Choose a .json, .yaml or .yml file'}
                      </span>
                      <input type="file" accept=".json,.yaml,.yml" className="hidden" onChange={onFile} />
                    </label>
                  </div>
                )}
              </div>
            )}

            {step === 2 && (
              <div className="space-y-3">
                <p className="text-sm text-slate-400">
                  Where should this connector run? Pick one or more — you can add more targets later.
                </p>
                {TARGET_OPTIONS.map((t) => {
                  const selected = targets.includes(t.id);
                  const Icon = TARGET_ICONS[t.id];
                  return (
                    <button
                      key={t.id}
                      type="button"
                      disabled={t.disabled}
                      onClick={() => toggleTarget(t.id)}
                      className={cn(
                        'w-full flex items-center gap-4 rounded-xl border p-4 text-left transition-colors',
                        t.disabled
                          ? 'border-white/10 opacity-50 cursor-not-allowed'
                          : selected
                            ? 'border-neon bg-neon/10 ring-1 ring-neon'
                            : 'border-white/10 hover:border-white/25',
                      )}
                    >
                      <span
                        className={cn(
                          'w-11 h-11 rounded-xl border flex items-center justify-center shrink-0',
                          selected ? 'bg-neon/15 border-neon/30' : 'bg-white/5 border-white/10',
                        )}
                      >
                        <Icon size={22} className={selected ? 'text-neon' : 'text-slate-500'} />
                      </span>
                      <div className="flex-1">
                        <div className="flex items-center gap-2">
                          <div className={cn('text-sm font-medium', selected ? 'text-slate-100' : 'text-slate-300')}>
                            {t.label}
                          </div>
                          {t.badge && <span className="badge badge-gray !text-[10px]">{t.badge}</span>}
                        </div>
                        <div className="text-xs text-slate-500 mt-0.5">
                          {t.desc}
                        </div>
                      </div>
                      <span
                        className={cn(
                          'w-5 h-5 rounded-full flex items-center justify-center shrink-0 border',
                          selected ? 'bg-neon border-neon' : 'border-white/20',
                        )}
                      >
                        {selected && <Check size={13} className="text-ink-950" />}
                      </span>
                    </button>
                  );
                })}
                {targets.length === 0 && (
                  <p className="text-xs text-amber-300">Select at least one target to continue.</p>
                )}
              </div>
            )}

            {step === 3 && (
              <div className="space-y-3">
                <p className="text-sm text-slate-400">
                  How should this connector authenticate to your API? The key is saved to
                  the project vault — never to a tool.
                </p>
                <UpstreamAuthFields
                  mode={authMode}
                  onMode={setAuthMode}
                  apiKey={apiKey}
                  onApiKey={setApiKey}
                  loginUri={loginUri}
                  onLoginUri={setLoginUri}
                  keyInputId="proj-api-key"
                  loginInputId="proj-login-uri"
                />
              </div>
            )}

            {step === 4 && (
              <div>
                <p className="text-sm text-slate-400 mb-4">
                  {needsImport
                    ? 'Nothing ships without your sign-off — creating the project saves it and imports your spec.'
                    : 'Nothing ships without your sign-off — creating the project saves it. Spec import for this source type arrives with the processing queue.'}
                </p>
                <dl className="rounded-xl border border-white/10 bg-white/5 px-4 py-2">
                  <KvRow k="Project">{name.trim()}</KvRow>
                  {description.trim() && <KvRow k="Description">{description.trim()}</KvRow>}
                  <KvRow k="API source">{method.title}</KvRow>
                  <KvRow k="Source detail">
                    <span className="mono text-xs break-all">{method.input === 'file' ? fileName : url.trim()}</span>
                  </KvRow>
                  <KvRow k="Targets">{formatTargets(targets)}</KvRow>
                  <KvRow k="Upstream auth">
                    {apiKey.trim() ? 'API key (saved on create)' : 'API key (add later from project details)'}
                  </KvRow>
                </dl>
              </div>
            )}

            {/* Nav */}
            <div className="flex items-center justify-between mt-8">
              <button
                onClick={() => (step === 0 ? navigate('/projects') : setStep(step - 1))}
                className="btn-ghost btn-sm"
              >
                <ArrowLeft size={14} /> Back
              </button>
              {step < STEPS.length - 1 ? (
                <button onClick={() => valid && setStep(step + 1)} disabled={!valid} className="btn-primary btn-sm">
                  Continue <ArrowRight size={14} />
                </button>
              ) : (
                <button
                  onClick={create}
                  disabled={atCap}
                  title={atCap && selectedPlan ? projectCapMessage(selectedPlan, usage) : undefined}
                  className="btn-primary btn-sm disabled:opacity-40"
                >
                  Create project <ArrowRight size={14} />
                </button>
              )}
            </div>
            {atCap && selectedPlan && (
              <p className="text-xs text-amber-300 mt-3 text-right">
                {projectCapMessage(selectedPlan, usage)}
              </p>
            )}
            {!valid && !atCap && (
              <p className="text-xs text-amber-300 mt-3 text-right">
                {step === 0 ? 'Give your project a name to continue.' : 'Add your API source to continue.'}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
