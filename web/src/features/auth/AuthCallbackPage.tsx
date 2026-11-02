import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { completeLogin } from './cognito';

/** Cognito hosted-UI callback: trades `?code=` for tokens, then lands in the app. */
export default function AuthCallbackPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const code = searchParams.get('code');
    const oauthError = searchParams.get('error');
    const oauthDesc = searchParams.get('error_description');
    if (oauthError) {
      setError(oauthDesc ?? oauthError);
      return;
    }
    if (!code) {
      setError('No authorization code returned from the sign-in page.');
      return;
    }
    completeLogin()
      .then(() => navigate('/dashboard', { replace: true }))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!error) {
    return (
      <div className="flex items-center gap-3 text-slate-400 text-sm">
        <span className="live-dot" />
        Finishing sign-in…
      </div>
    );
  }
  return (
    <div className="max-w-md card p-6">
      <h1 className="text-lg font-semibold text-white mb-2">Sign-in didn&apos;t complete</h1>
      <p className="text-sm text-slate-400 mb-4">{error}</p>
      <button className="btn-secondary btn-sm" onClick={() => navigate('/dashboard')}>
        Back to console
      </button>
    </div>
  );
}
