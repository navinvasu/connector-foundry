// SE-07: production config boot guards. Development must stay frictionless;
// production must refuse development-grade posture instead of booting with it.
import { describe, it, expect } from 'vitest';
import { assertProductionConfig } from './boot-guards.js';

const PROD_OK: NodeJS.ProcessEnv = {
  NODE_ENV: 'production',
  CF_SIGNING_SECRET: 'a-real-secret',
  COGNITO_CLIENT_ID: 'client-123',
};

describe('assertProductionConfig', () => {
  it('passes a fully configured production env', () => {
    expect(() => assertProductionConfig({ ...PROD_OK })).not.toThrow();
  });

  it('refuses CF_DEV_AUTH=true in production (F-1)', () => {
    expect(() => assertProductionConfig({ ...PROD_OK, CF_DEV_AUTH: 'true' }))
      .toThrow(/CF_DEV_AUTH=true in production/);
  });

  it('refuses a missing signing secret in production (F-6)', () => {
    const env = { ...PROD_OK };
    delete env.CF_SIGNING_SECRET;
    expect(() => assertProductionConfig(env)).toThrow(/CF_SIGNING_SECRET is not set/);
  });

  it('refuses the public dev signing secret in production (F-6)', () => {
    expect(() => assertProductionConfig({ ...PROD_OK, CF_SIGNING_SECRET: 'dev-only-signing-secret' }))
      .toThrow(/public dev default/);
  });

  it('refuses a missing Cognito client id in production (F-11)', () => {
    const env = { ...PROD_OK };
    delete env.COGNITO_CLIENT_ID;
    expect(() => assertProductionConfig(env)).toThrow(/COGNITO_CLIENT_ID is not set/);
  });

  it('never fires outside production — bare dev env boots', () => {
    expect(() => assertProductionConfig({ NODE_ENV: 'development' })).not.toThrow();
    expect(() => assertProductionConfig({})).not.toThrow();
    expect(() => assertProductionConfig({ NODE_ENV: 'test', CF_DEV_AUTH: 'true' })).not.toThrow();
  });
});
