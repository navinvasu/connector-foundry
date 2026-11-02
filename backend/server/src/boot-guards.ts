// Production config boot guards (SE-07, from SE-06 finding F-1/F-6/F-11).
//
// The failure mode these exist for: a deployment where an env var is unset
// or copied from a dev .env silently runs with a development-grade posture
// (dev auth bypass, public signing secret, any-client Cognito tokens).
// assertBrokerBoot refuses the analogous broker downgrade; this is the
// same "server refuses" treatment for auth + signing config. Called once
// from index.ts before migrate/listen.
//
// Development is untouched: every guard fires only when
// NODE_ENV=production.

import { logger } from './logger.js';

/** The public-in-source fallback in runtime.ts/release.ts. Never valid in prod. */
const DEV_SIGNING_SECRET = 'dev-only-signing-secret';

export function assertProductionConfig(env: NodeJS.ProcessEnv = process.env): void {
  if (env.NODE_ENV !== 'production') return;

  if (env.CF_DEV_AUTH === 'true') {
    throw new Error(
      'Refusing to boot: CF_DEV_AUTH=true in production. Dev auth makes every ' +
      'request a platform admin (and honors x-dev-as impersonation). Unset it and configure Cognito.',
    );
  }
  if (!env.CF_SIGNING_SECRET?.trim()) {
    throw new Error(
      'Refusing to boot: CF_SIGNING_SECRET is not set in production. ' +
      'Release signatures would use the public dev default.',
    );
  }
  if (env.CF_SIGNING_SECRET.trim() === DEV_SIGNING_SECRET) {
    throw new Error(
      'Refusing to boot: CF_SIGNING_SECRET is the public dev default in production. Set a real secret.',
    );
  }
  if (!env.COGNITO_CLIENT_ID?.trim()) {
    throw new Error(
      'Refusing to boot: COGNITO_CLIENT_ID is not set in production. ' +
      'Without it, access tokens from any client of the shared pool would be accepted.',
    );
  }
}

/** One boot log line naming the resolved modes (never secret values). */
export function logResolvedConfig(env: NodeJS.ProcessEnv = process.env): void {
  logger.info({
    msg: 'config',
    auth: env.CF_DEV_AUTH === 'true' ? 'dev' : 'cognito',
    signing: env.CF_SIGNING_SECRET?.trim() && env.CF_SIGNING_SECRET.trim() !== DEV_SIGNING_SECRET ? 'env' : 'dev-default',
    broker: env.CF_BROKER_KMS_KEY_ID?.trim() ? 'kms' : env.CF_BROKER_DEV_KEY?.trim() ? 'dev-key' : 'unconfigured',
  });
}
