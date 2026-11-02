import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, Building2, Loader2 } from 'lucide-react';
import { createOrganization } from '../../data/api';

// FE-07: "Create your organization." A signed-in user with no membership
// used to land in a console with no workspace they could act in; now they
// get this step. The server creates the customer on the trial plan, makes
// the caller its owner (no sample project, D-87) — so success lands on
// /onboarding (FE-02), where the guided tour takes them from zero to their
// first import; skipping the tour lands on /dashboard.
export default function CreateOrganizationPage() {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const valid = name.trim().length > 0;

  const create = async () => {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      await createOrganization({ name: name.trim() });
      navigate('/onboarding');
    } catch (e: any) {
      setError(e.message ?? String(e));
      setBusy(false);
    }
  };

  return (
    <div className="max-w-xl mx-auto space-y-6">
      <div>
        <h1 className="page-title">Create your organization</h1>
        <p className="page-sub">
          Your workspace for connectors — projects, teammates, and billing all live under it.
        </p>
      </div>

      <div className="card panel-glow p-6 space-y-5">
        <div className="flex items-start gap-3">
          <span className="w-10 h-10 rounded-xl bg-neon/15 border border-neon/30 flex items-center justify-center shrink-0">
            <Building2 size={19} className="text-neon" />
          </span>
          <p className="text-sm text-slate-400 leading-relaxed">
            You&apos;ll be its <span className="text-slate-200 font-medium">owner</span> and start on the
            free <span className="text-slate-200 font-medium">trial plan</span> (14 days). Next you&apos;ll
            import your own API.
          </p>
        </div>

        {error && (
          <div className="rounded-xl border border-red-400/30 bg-red-400/10 p-4 text-sm text-red-200">
            {error}
          </div>
        )}

        <div>
          <label className="label" htmlFor="org-name">Organization name</label>
          <input
            id="org-name"
            className="input"
            placeholder="e.g. Acme Inc."
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void create(); }}
            autoFocus
          />
        </div>


        <div className="flex justify-end">
          <button onClick={() => void create()} disabled={!valid || busy} className="btn-primary btn-sm">
            {busy ? <Loader2 size={14} className="animate-spin" /> : null}
            Create organization <ArrowRight size={14} />
          </button>
        </div>
        {!valid && (
          <p className="text-xs text-amber-300 text-right">Give your organization a name to continue.</p>
        )}
      </div>
    </div>
  );
}
