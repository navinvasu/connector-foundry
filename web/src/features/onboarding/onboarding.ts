// FE-02: guided onboarding ("zero to first import in under 5 minutes").
//
// Pure, testable core of the onboarding wizard. The page component
// (OnboardingWizardPage.tsx) owns React state and API calls; everything here
// is a pure function so it can be covered by vitest without a DOM.

export const ONBOARDING_STEPS = [
  'Welcome',
  'Name your project',
  'Bring your API',
  'Upstream auth',
  'Building',
  'Done',
] as const;

export type OnboardingMethod = 'openapi-url' | 'upload' | 'postman' | 'docs';

export interface OnboardingMethodDef {
  id: OnboardingMethod;
  title: string;
  desc: string;
  badge?: string;
  input: 'url' | 'file';
  placeholder?: string;
  note?: string;
}

// Mirrors NewProjectPage's SOURCE_METHODS (FE-10). Kept as a separate list so
// the onboarding wizard can diverge (e.g. a shorter method list) without
// touching the working New Project wizard; a follow-up unifies them.
export const ONBOARDING_METHODS: OnboardingMethodDef[] = [
  {
    id: 'openapi-url',
    title: 'OpenAPI 3.x URL',
    desc: 'Point us at your spec — the fastest path.',
    badge: 'Recommended',
    input: 'url',
    placeholder: 'https://api.example.com/openapi.json',
  },
  {
    id: 'upload',
    title: 'Upload a spec file',
    desc: 'OpenAPI or Swagger JSON / YAML from your machine.',
    input: 'file',
  },
  {
    id: 'postman',
    title: 'Postman collection',
    desc: 'We normalize collections into the same canonical model.',
    input: 'url',
    placeholder: 'https://api.example.com/collection.json',
  },
  {
    id: 'docs',
    title: 'Docs URL',
    desc: 'No machine-readable spec? Bring the docs link and add the spec when you have it.',
    input: 'url',
    placeholder: 'https://docs.example.com/api-reference',
    note: 'Guided import arrives with IA-03 — for now the project is created and import waits.',
  },
];

export interface OnboardingDraft {
  name: string;
  customerId: string;
  methodId: OnboardingMethod;
  url: string;
  fileName: string;
  /** Upstream auth choice — the key itself stays in page state (never in the
   *  draft). The access-token method is disabled for the demo, so the auth
   *  step never blocks. */
  authMode?: 'api_key' | 'access_token';
}

/** Per-step "Continue" gating for the wizard. */
export function onboardingStepValid(step: number, draft: OnboardingDraft): boolean {
  if (step === 0) return true;
  if (step === 1) return draft.name.trim().length > 0 && draft.customerId.length > 0;
  if (step === 2) {
    const method = ONBOARDING_METHODS.find((m) => m.id === draft.methodId);
    if (!method) return false;
    return method.input === 'file' ? draft.fileName.length > 0 : draft.url.trim().length > 0;
  }
  return true; // Upstream auth (optional key) + Building + Done are always passable.
}

/** Docs URLs have no normalizer yet (IA-03) — the wizard creates the project
 *  and leaves import for later, same as the New Project wizard. */
export function onboardingNeedsImport(methodId: OnboardingMethod): boolean {
  return methodId === 'openapi-url' || methodId === 'upload' || methodId === 'postman';
}

/** Maps the wizard method to the backend importSource type. */
export function onboardingImportType(methodId: OnboardingMethod): 'openapi_url' | 'openapi_text' | 'postman_url' {
  if (methodId === 'postman') return 'postman_url';
  if (methodId === 'upload') return 'openapi_text';
  return 'openapi_url';
}

// ─── Dismissal ───────────────────────────────────────────────────────────────
// The wizard is offered once per browser (first run after org creation). Skip
// or completion records dismissal in localStorage; nothing here is a nudge.

const DISMISS_KEY = 'foundry.onboarding.dismissed.v1';

interface DismissStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const safeStorage = (storage: DismissStorage | undefined): DismissStorage | null => {
  if (!storage) return null;
  try {
    storage.getItem(DISMISS_KEY);
    return storage;
  } catch {
    return null; // private-mode / disabled storage — never nag.
  }
};

export function onboardingDismissed(storage?: DismissStorage): boolean {
  const s = safeStorage(storage ?? (typeof localStorage !== 'undefined' ? localStorage : undefined));
  return s?.getItem(DISMISS_KEY) === '1';
}

export function dismissOnboarding(storage?: DismissStorage): void {
  const s = safeStorage(storage ?? (typeof localStorage !== 'undefined' ? localStorage : undefined));
  s?.setItem(DISMISS_KEY, '1');
}

export function resetOnboardingDismissal(storage?: DismissStorage): void {
  const s = safeStorage(storage ?? (typeof localStorage !== 'undefined' ? localStorage : undefined));
  s?.removeItem(DISMISS_KEY);
}
