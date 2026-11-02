// FE-02: guided onboarding wizard — "zero to first import in under 5 minutes".
//
// Route: /onboarding (inside the console Layout, same chrome as the New
// Project wizard). Entry points:
//   - CreateOrganizationPage redirects here after first org creation (FE-07),
//     so every new signup lands on the tour;
//   - the Projects empty state offers "Start the guided tour" for existing
//     users who skipped it.
// Skip or completion dismisses the tour (localStorage, onboarding.ts).

import { useEffect, useState } from 'react';
import type { ChangeEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft, ArrowRight, BookOpen, Check, FileText, Link2, Loader2, Rocket, Upload,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useFoundryStore } from '../../app/store';
import {
  ApiError, createProject, getMe, getProject, importSource, mapBackendProject, saveCredential,
  type WorkspaceMembership,
} from '../../data/api';
import type { ProjectSummary, UpstreamAuthMode } from '../../data/projects';
import UpstreamAuthFields from '../projects/UpstreamAuthFields';
import { UPGRADE_NUDGE } from '../../data/plan';
import { ErrorState, KvRow, LoadingState, ProgressBar } from '../../shared/components/atoms';
import { cn } from '../../shared/lib/utils';
import {
  ONBOARDING_METHODS,
  ONBOARDING_STEPS,
  dismissOnboarding,
  onboardingImportType,
  onboardingNeedsImport,
  onboardingStepValid,
  type OnboardingDraft,
  type OnboardingMethod,
} from './onboarding';

const METHOD_ICONS: Record<OnboardingMethod, LucideIcon> = {
  'openapi-url': Link2,
  upload: Upload,
  postman: FileText,
  docs: BookOpen,
};

type BuildPhase = 'creating' | 'importing' | 'reading';

interface BuildResult {
  project: ProjectSummary;
  operations: number;
  findings: number;
  importSkipped: boolean; // docs method — IA-03 not shipped yet
  importFailed: boolean;
  importError?: string;
  keyFailed: boolean; // key save is non-fatal — retry from the detail page
}

export default function OnboardingWizardPage() {
  const navigate = useNavigate();
  const addProject = useFoundryStore((s) => s.addProject);

  const [step, setStep] = useState(0);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [memberships, setMemberships] = useState<WorkspaceMembership[]>([]);
  const [customerId, setCustomerId] = useState('');
  const [meLoading, setMeLoading] = useState(true);
  const [meError, setMeError] = useState<string | null>(null);

  const [methodId, setMethodId] = useState<OnboardingMethod>('openapi-url');
  const [url, setUrl] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [fileName, setFileName] = useState('');
  const [authMode, setAuthMode] = useState<UpstreamAuthMode>('api_key');
  const [apiKey, setApiKey] = useState('');
  const [loginUri, setLoginUri] = useState('');

  const [buildPhase, setBuildPhase] = useState<BuildPhase | null>(null);
  const [buildLabel, setBuildLabel] = useState('');
  const [fatalError, setFatalError] = useState<string | null>(null);
  const [capBlocked, setCapBlocked] = useState(false);
  const [result, setResult] = useState<BuildResult | null>(null);

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

  const draft: OnboardingDraft = { name, customerId, methodId, url, fileName, authMode };
  const canContinue = onboardingStepValid(step, draft) && !meLoading && !meError;

  const skip = () => {
    dismissOnboarding();
    navigate('/dashboard');
  };

  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0] ?? null;
    setFile(f);
    setFileName(f ? f.name : '');
  };

  // Runs the real create → import → read sequence, then lands on Done.
  const build = async () => {
    setFatalError(null);
    setCapBlocked(false);
    try {
      setStep(4);
      setBuildPhase('creating');
      setBuildLabel('Creating your project…');
      const { project } = await createProject({
        name: name.trim(),
        description: description.trim() || undefined,
        targets: ['mcp', 'openai', 'muse'],
        customer_id: customerId,
      });
      let saved = mapBackendProject(project);

      // The upstream key belongs to the project — save it to the vault now.
      // Non-fatal: the key can be added later from the project detail page.
      let keyFailed = false;
      if (authMode === 'api_key' && apiKey.trim().length > 0) {
        try {
          await saveCredential(project.id, 'default', apiKey.trim());
        } catch {
          keyFailed = true;
        }
      }

      let operations = 0;
      let findings = 0;
      let importFailed = false;
      let importError: string | undefined;
      const importSkipped = !onboardingNeedsImport(methodId);
      if (!importSkipped) {
        setBuildPhase('importing');
        setBuildLabel('Importing your API spec…');
        try {
          const payload =
            methodId === 'upload' ? await (file as File).text() : url.trim();
          const res = await importSource(project.id, onboardingImportType(methodId), payload);
          operations = res.inventory.operations.length;
          findings = res.inventory.findings.length;
        } catch (e: any) {
          // The project row is real even when the import blows up — surface
          // it and let the user retry from the Import screen (no dead end).
          importFailed = true;
          importError = e.message ?? String(e);
        }
      }

      setBuildPhase('reading');
      setBuildLabel('Reading your project…');
      try {
        saved = await getProject(project.id);
      } catch {
        // Keep the mapped row; counts just stay approximate.
      }
      addProject(saved); // also makes it the active project
      dismissOnboarding();
      setResult({ project: saved, operations, findings, importSkipped, importFailed, importError, keyFailed });
      setBuildPhase(null);
      setStep(5);
    } catch (e: any) {
      setBuildPhase(null);
      if (e instanceof ApiError && e.code === 'project_limit_reached') {
        // FE-03: plan cap is enforced server-side — show the designed blocked
        // state with the upgrade nudge, not a raw error string.
        setCapBlocked(true);
      } else {
        setFatalError(e.message ?? String(e));
      }
    }
  };

  const method = ONBOARDING_METHODS.find((m) => m.id === methodId) ?? ONBOARDING_METHODS[0];

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div>
        <h1 className="page-title">Welcome to Connector Foundry</h1>
        <p className="page-sub">From your API to a tested agent connector in under 5 minutes.</p>
      </div>

      {/* Stepper */}
      <div className="flex items-center">
        {ONBOARDING_STEPS.map((label, i) => (
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
            {i < ONBOARDING_STEPS.length - 1 && (
              <div className={cn('flex-1 h-px mx-2 mb-5', i < step ? 'bg-emerald-400/40' : 'bg-white/10')} />
            )}
          </div>
        ))}
      </div>

      <div className="card p-6">
        {step === 0 && (
          <div className="space-y-5 text-center">
            <div className="mx-auto w-12 h-12 rounded-2xl bg-neon/10 border border-neon/30 flex items-center justify-center">
              <Rocket size={22} className="text-neon" />
            </div>
            <div className="space-y-2">
              <h2 className="font-display text-xl text-white">Three steps to your first connector</h2>
              <p className="text-sm text-slate-400 max-w-md mx-auto">
                We'll create a project, import your API, and show you the tools Foundry drafted from
                it. You can skip any time — the console is yours to explore.
              </p>
            </div>
            <ol className="text-left max-w-md mx-auto space-y-3">
              {[
                ['1', 'Name your project', 'One line — this becomes your connector\'s home.'],
                ['2', 'Point us at your API', 'An OpenAPI URL, a spec file, or a Postman collection.'],
                ['3', 'See your tools', 'Review the draft tools, then evaluate and publish.'],
              ].map(([n, t, d]) => (
                <li key={n} className="flex gap-3">
                  <span className="w-6 h-6 rounded-full bg-neon/15 border border-neon/40 text-neon text-xs font-semibold flex items-center justify-center shrink-0 mt-0.5">{n}</span>
                  <div>
                    <div className="text-sm font-medium text-slate-100">{t}</div>
                    <div className="text-xs text-slate-500">{d}</div>
                  </div>
                </li>
              ))}
            </ol>
            <div className="flex items-center justify-center gap-3 pt-1">
              <button onClick={skip} className="btn-secondary">
                Skip — I'll explore
              </button>
              <button onClick={() => setStep(1)} className="btn-primary">
                Start the tour <ArrowRight size={15} />
              </button>
            </div>
          </div>
        )}

        {step === 1 && (
          <div className="space-y-4">
            {meLoading ? (
              <LoadingState label="Loading your workspaces…" />
            ) : meError ? (
              <ErrorState
                message={`Couldn't load your workspaces: ${meError}`}
                hint="Check the backend is running, then retry."
                onRetry={() => window.location.reload()}
              />
            ) : memberships.length === 0 ? (
              <div className="space-y-3 text-center py-4">
                <p className="text-sm text-amber-300">You have no workspace you can create projects in yet.</p>
                <button onClick={() => navigate('/organizations/new')} className="btn-secondary btn-sm mx-auto">
                  Create your organization <ArrowRight size={14} />
                </button>
              </div>
            ) : (
              <>
                <div>
                  <label className="label" htmlFor="ob-workspace">Workspace</label>
                  {memberships.length === 1 ? (
                    <p className="text-sm text-slate-300">
                      {memberships[0].customer_name}
                      <span className="text-slate-500 text-xs ml-2">{memberships[0].plan_name}</span>
                    </p>
                  ) : (
                    <select
                      id="ob-workspace"
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
                </div>
                <div>
                  <label className="label" htmlFor="ob-name">Project name</label>
                  <input
                    id="ob-name"
                    className="input"
                    placeholder="e.g. Acme Billing API"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    autoFocus
                  />
                </div>
                <div>
                  <label className="label" htmlFor="ob-desc">
                    Description <span className="text-slate-500 font-normal">(optional)</span>
                  </label>
                  <textarea
                    id="ob-desc"
                    className="input min-h-[80px] resize-y"
                    placeholder="What does this API do? Who will use the connector?"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                  />
                </div>
              </>
            )}
          </div>
        )}

        {step === 2 && (
          <div className="space-y-4">
            <p className="text-sm text-slate-400">
              Bring what you have — we'll normalize it into the same canonical model.
            </p>
            <div className="grid sm:grid-cols-2 gap-3">
              {ONBOARDING_METHODS.map((m) => {
                const Icon = METHOD_ICONS[m.id];
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
                      <Icon size={17} className={selected ? 'text-neon' : 'text-slate-400'} />
                      <span className="text-sm font-medium text-slate-100">{m.title}</span>
                      {m.badge && (
                        <span className="badge badge-blue !text-[10px] ml-auto">{m.badge}</span>
                      )}
                    </div>
                    <p className="text-xs text-slate-500 mt-1.5">{m.desc}</p>
                    {m.note && selected && (
                      <p className="text-xs text-amber-300/90 mt-2">{m.note}</p>
                    )}
                  </button>
                );
              })}
            </div>
            {method.input === 'url' ? (
              <div>
                <label className="label" htmlFor="ob-url">{method.title}</label>
                <input
                  id="ob-url"
                  className="input"
                  placeholder={method.placeholder}
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  autoFocus
                />
              </div>
            ) : (
              <div>
                <label className="label" htmlFor="ob-file">Spec file</label>
                <input
                  id="ob-file"
                  type="file"
                  accept=".json,.yaml,.yml"
                  className="input"
                  onChange={onFile}
                />
                {fileName && <p className="text-xs text-slate-500 mt-1.5">Selected: {fileName}</p>}
              </div>
            )}
          </div>
        )}

        {step === 3 && (
          <div className="space-y-4">
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
              keyInputId="ob-api-key"
              loginInputId="ob-login-uri"
            />
          </div>
        )}

        {step === 4 && (
          <div className="flex flex-col items-center justify-center py-14 text-center">
            <Loader2 size={32} className="text-neon animate-spin" />
            <div className="font-display text-lg text-white mt-5">{buildLabel}</div>
            <p className="text-sm text-slate-400 mt-2 max-w-sm">
              {buildPhase === 'creating' && 'Writing the project to your workspace registry.'}
              {buildPhase === 'importing' && 'Fetching the spec and mapping operations into the canonical model.'}
              {buildPhase === 'reading' && 'Loading your project summary.'}
            </p>
            <div className="w-64 max-w-full mt-6">
              <ProgressBar value={100} tone="brand" />
            </div>
          </div>
        )}

        {step === 5 && result && (
          <div className="space-y-5 text-center">
            <div className="mx-auto w-12 h-12 rounded-2xl bg-emerald-400/10 border border-emerald-400/30 flex items-center justify-center">
              <Check size={22} className="text-emerald-300" />
            </div>
            <div className="space-y-2">
              <h2 className="font-display text-xl text-white">
                {result.importFailed ? 'Your project is saved' : 'Your first import is in'}
              </h2>
              <p className="text-sm text-slate-400 max-w-md mx-auto">
                {result.importFailed
                  ? `“${result.project.name}” was created, but the import failed. Retry it from the Import screen — nothing is lost.`
                  : result.importSkipped
                    ? `“${result.project.name}” is ready. Paste a spec URL or upload a spec file from the Import screen whenever you have one.`
                    : `“${result.project.name}” is ready. Here's what we found in your API:`}
              </p>
            </div>
            {!result.importFailed && !result.importSkipped && (
              <div className="max-w-sm mx-auto text-left rounded-xl border border-white/10 divide-y divide-white/10">
                <KvRow k="Operations imported">{result.operations}</KvRow>
                <KvRow k="Findings to review">{result.findings}</KvRow>
              </div>
            )}
            {result.importFailed && (
              <p className="text-xs text-red-300 max-w-md mx-auto" role="alert">
                Import error: {result.importError}
              </p>
            )}
            {result.keyFailed && (
              <p className="text-xs text-amber-300 max-w-md mx-auto" role="alert">
                The API key wasn&apos;t saved — add it from the project detail page before evaluating.
              </p>
            )}
            <div className="flex flex-wrap items-center justify-center gap-3 pt-1">
              {result.importFailed ? (
                <button onClick={() => navigate('/import')} className="btn-primary">
                  Retry the import <ArrowRight size={15} />
                </button>
              ) : (
                <button onClick={() => navigate('/dashboard')} className="btn-primary">
                  View dashboard <ArrowRight size={15} />
                </button>
              )}
            </div>
          </div>
        )}

        {/* Terminal error states — always offer a way forward (FE-05 contract). */}
        {capBlocked && (
          <div className="space-y-3 text-center py-4" role="alert">
            <p className="text-sm text-amber-300">You've reached your plan's project limit.</p>
            <p className="text-xs text-slate-500 max-w-md mx-auto">{UPGRADE_NUDGE}</p>
            <div className="flex items-center justify-center gap-3">
              <button onClick={() => { setCapBlocked(false); setStep(3); }} className="btn-secondary btn-sm">
                <ArrowLeft size={14} /> Back
              </button>
              <button onClick={() => navigate('/dashboard')} className="btn-ghost btn-sm">
                Back to dashboard
              </button>
            </div>
          </div>
        )}
        {fatalError && (
          <div className="pt-2">
            <ErrorState
              message={`Couldn't create the project: ${fatalError}`}
              hint="Your workspace is untouched — nothing was saved."
              onRetry={() => { setFatalError(null); setStep(3); }}
            />
          </div>
        )}
      </div>

      {/* Wizard nav — hidden on Welcome/Building/Done and terminal error states. */}
      {(step === 1 || step === 2 || step === 3) && !capBlocked && !fatalError && (
        <div className="flex items-center justify-between">
          <button
            onClick={() => setStep((s) => Math.max(0, s - 1))}
            className="btn-ghost btn-sm"
          >
            <ArrowLeft size={14} /> Back
          </button>
          <div className="flex items-center gap-3">
            <button onClick={skip} className="btn-ghost btn-sm">
              Skip tour
            </button>
            {step === 3 ? (
              <button onClick={build} disabled={!canContinue} className="btn-primary btn-sm disabled:opacity-40">
                Import my API <ArrowRight size={14} />
              </button>
            ) : (
              <button onClick={() => setStep(step + 1)} disabled={!canContinue} className="btn-primary btn-sm disabled:opacity-40">
                Continue <ArrowRight size={14} />
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
