import type { ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { Hexagon } from 'lucide-react';
import { beginLogin, isCognitoConfigured, isSignedIn } from './cognito';

/** Paths that must render while signed out: the hosted-UI return and the sign-up entry. */
const PUBLIC_PATHS = ['/auth/callback', '/signup'];

/**
 * With Cognito configured, a signed-out visitor sees the sign-in screen
 * instead of a console shell full of 401s. Local dev (no VITE_COGNITO_*)
 * passes straight through to the dev login.
 */
export default function AuthGate({ children }: { children: ReactNode }) {
  const location = useLocation();
  if (!isCognitoConfigured() || isSignedIn() || PUBLIC_PATHS.includes(location.pathname)) {
    return <>{children}</>;
  }
  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="card p-8 w-full max-w-sm text-center">
        <div className="w-12 h-12 mx-auto mb-4 rounded-lg bg-neon/15 border border-neon/30 flex items-center justify-center shadow-glow">
          <Hexagon className="w-6 h-6 text-neon" />
        </div>
        <h1 className="font-display text-lg font-semibold text-white tracking-wide">CONNECTOR FOUNDRY</h1>
        <p className="text-sm text-slate-400 mt-2 mb-6">
          Turn your API into evaluated, publishable tools for AI agents.
        </p>
        <div className="flex flex-col gap-3">
          <button className="btn-primary" onClick={() => void beginLogin()}>Sign in</button>
          <button className="btn-secondary" onClick={() => void beginLogin(true)}>Create account</button>
        </div>
      </div>
    </div>
  );
}
