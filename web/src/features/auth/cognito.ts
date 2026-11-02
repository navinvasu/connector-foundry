// ─── Connector Foundry — Cognito hosted UI (thin adapter over @vir/web-auth, LIB-05) ─────────
// The PKCE flow, token storage, refresh and client checks live in libs/web-common/auth. This file
// only maps the console's Vite env vars onto it; it stays inert until they are set:
//   VITE_COGNITO_DOMAIN       e.g. https://foundry-auth.auth.us-east-1.amazoncognito.com
//   VITE_COGNITO_CLIENT_ID    app client id (public client, PKCE, no secret)
//   VITE_COGNITO_REDIRECT_URI default <origin>/auth/callback
// The console keeps its session across browser restarts (persist: true, as before).

import {
  beginLogin as libBeginLogin,
  configureAuth,
  getAccessToken,
  handleCallback,
  isAuthConfigured,
  isSignedIn,
  logout,
} from '@vir/web-auth';

const env: Record<string, string | undefined> = ((import.meta as any).env ?? {});

configureAuth({
  domain: env.VITE_COGNITO_DOMAIN ?? '',
  clientId: env.VITE_COGNITO_CLIENT_ID ?? '',
  redirectUri:
    env.VITE_COGNITO_REDIRECT_URI ??
    (typeof window !== 'undefined' ? `${window.location.origin}/auth/callback` : ''),
  persist: true,
});

export const isCognitoConfigured = isAuthConfigured;
export { getAccessToken, isSignedIn, logout };

/** Start the hosted-UI sign-in (or sign-up) flow. */
export const beginLogin = (signup = false): Promise<void> => libBeginLogin({ signup });

/** Finishes the hosted-UI redirect on /auth/callback. */
export const completeLogin = (): Promise<void> => handleCallback(window.location.href);
