import { describe, expect, it } from 'vitest';
import {
  ONBOARDING_METHODS,
  ONBOARDING_STEPS,
  dismissOnboarding,
  onboardingDismissed,
  onboardingImportType,
  onboardingNeedsImport,
  onboardingStepValid,
  resetOnboardingDismissal,
  type OnboardingDraft,
} from './onboarding';

const baseDraft = (): OnboardingDraft => ({
  name: 'Acme Billing',
  customerId: 'cus_1',
  methodId: 'openapi-url',
  url: 'https://api.example.com/openapi.json',
  fileName: '',
});

describe('onboarding steps', () => {
  it('has six labeled steps starting with Welcome', () => {
    expect(ONBOARDING_STEPS).toHaveLength(6);
    expect(ONBOARDING_STEPS[0]).toBe('Welcome');
    expect(ONBOARDING_STEPS[3]).toBe('Upstream auth');
    expect(ONBOARDING_STEPS[5]).toBe('Done');
  });

  it('exposes four source methods with the OpenAPI URL recommended', () => {
    expect(ONBOARDING_METHODS.map((m) => m.id)).toEqual(['openapi-url', 'upload', 'postman', 'docs']);
    expect(ONBOARDING_METHODS[0].badge).toBe('Recommended');
  });
});

describe('onboardingStepValid', () => {
  it('step 0 (welcome) is always passable', () => {
    expect(onboardingStepValid(0, { ...baseDraft(), name: '', customerId: '' })).toBe(true);
  });

  it('step 1 requires a project name and a workspace', () => {
    expect(onboardingStepValid(1, baseDraft())).toBe(true);
    expect(onboardingStepValid(1, { ...baseDraft(), name: '   ' })).toBe(false);
    expect(onboardingStepValid(1, { ...baseDraft(), customerId: '' })).toBe(false);
  });

  it('step 2 requires a URL for url methods', () => {
    expect(onboardingStepValid(2, baseDraft())).toBe(true);
    expect(onboardingStepValid(2, { ...baseDraft(), url: '  ' })).toBe(false);
    expect(onboardingStepValid(2, { ...baseDraft(), methodId: 'postman' })).toBe(true);
    expect(onboardingStepValid(2, { ...baseDraft(), methodId: 'docs' })).toBe(true);
  });

  it('step 2 requires a file for the upload method', () => {
    const d = { ...baseDraft(), methodId: 'upload' as const, fileName: '' };
    expect(onboardingStepValid(2, d)).toBe(false);
    expect(onboardingStepValid(2, { ...d, fileName: 'openapi.yaml' })).toBe(true);
  });

  it('auth, building and done steps are always passable', () => {
    expect(onboardingStepValid(3, baseDraft())).toBe(true);
    expect(onboardingStepValid(4, baseDraft())).toBe(true);
    expect(onboardingStepValid(5, baseDraft())).toBe(true);
  });
});

describe('onboardingNeedsImport / onboardingImportType', () => {
  it('docs URLs skip import — IA-03 has no normalizer yet', () => {
    expect(onboardingNeedsImport('docs')).toBe(false);
    expect(onboardingNeedsImport('openapi-url')).toBe(true);
    expect(onboardingNeedsImport('upload')).toBe(true);
    expect(onboardingNeedsImport('postman')).toBe(true);
  });

  it('maps wizard methods to backend import types', () => {
    expect(onboardingImportType('openapi-url')).toBe('openapi_url');
    expect(onboardingImportType('postman')).toBe('postman_url');
    expect(onboardingImportType('upload')).toBe('openapi_text');
  });
});

describe('onboarding dismissal', () => {
  const fakeStorage = () => {
    const map = new Map<string, string>();
    return {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => { map.set(k, v); },
      removeItem: (k: string) => { map.delete(k); },
    };
  };

  it('starts undismissed, dismisses, and resets', () => {
    const s = fakeStorage();
    expect(onboardingDismissed(s)).toBe(false);
    dismissOnboarding(s);
    expect(onboardingDismissed(s)).toBe(true);
    resetOnboardingDismissal(s);
    expect(onboardingDismissed(s)).toBe(false);
  });

  it('treats any non-"1" value as undismissed', () => {
    const s = fakeStorage();
    s.setItem('foundry.onboarding.dismissed.v1', 'yes');
    expect(onboardingDismissed(s)).toBe(false);
  });

  it('never throws when storage is unavailable', () => {
    const broken = {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('denied'); },
      removeItem: () => { throw new Error('denied'); },
    };
    expect(() => dismissOnboarding(broken)).not.toThrow();
    expect(onboardingDismissed(broken)).toBe(false);
    expect(() => resetOnboardingDismissal(broken)).not.toThrow();
  });
});
