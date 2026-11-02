/** Actionable smoke-run hint for a server error message, or null when the
 *  error needs no translation. Kept pure so it is unit-testable — smoke.ts
 *  itself runs at import time. */
export function smokeHintFor(message: string): string | null {
  if (message.includes('credential_storage_not_configured')) {
    return (
      'The server has no credential vault configured, so the API key cannot be stored. ' +
      'Generate a local vault key (`openssl rand -hex 32`), set it as CF_BROKER_DEV_KEY in ' +
      'backend/server/.env, restart the server (./dev.sh — boot log must say "broker":"dev-key"), ' +
      'then re-run this smoke. Full steps: projects/connector-foundry/docs/local-run.md, Step 2.'
    );
  }
  return null;
}
