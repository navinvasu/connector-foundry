import { useEffect } from 'react';
import { Navigate } from 'react-router-dom';
import { beginLogin, isCognitoConfigured, isSignedIn } from './cognito';

/**
 * /signup — the website's "Start free" link. Sends a signed-out visitor
 * straight to the hosted sign-up page; a signed-in one lands in the console.
 */
export default function SignupPage() {
  const go = isCognitoConfigured() && !isSignedIn();
  useEffect(() => {
    if (go) void beginLogin(true);
  }, [go]);
  if (!go) return <Navigate to="/dashboard" replace />;
  return (
    <div className="flex items-center gap-3 text-slate-400 text-sm">
      <span className="live-dot" />
      Opening sign-up…
    </div>
  );
}
