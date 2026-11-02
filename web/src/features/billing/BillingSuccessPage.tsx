// Shown after Stripe redirects back from a successful checkout.
// The webhook usually lands within seconds; we poll until the workspace
// flips to active so the customer sees confirmation, not a race.

import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { CheckCircle2, Loader2 } from 'lucide-react';
import { getBilling } from '../../data/api';

export default function BillingSuccessPage() {
  const [params] = useSearchParams();
  const customerId = params.get('customer');
  const [state, setState] = useState<'waiting' | 'done' | 'slow'>('waiting');

  useEffect(() => {
    if (!customerId) { setState('done'); return; }
    let tries = 0;
    let cancelled = false;
    const poll = async () => {
      try {
        const { billing } = await getBilling(customerId);
        if (cancelled) return;
        if (billing.status === 'active') { setState('done'); return; }
      } catch { /* keep polling through transient errors */ }
      tries += 1;
      if (cancelled) return;
      if (tries >= 15) { setState('slow'); return; }
      setTimeout(poll, 2000);
    };
    poll();
    return () => { cancelled = true; };
  }, [customerId]);

  return (
    <div className="max-w-lg mx-auto mt-16 card p-8 text-center space-y-4">
      {state === 'done' ? (
        <>
          <CheckCircle2 size={40} className="mx-auto text-emerald-400" />
          <h1 className="page-title">You're on a paid package</h1>
          <p className="page-sub">
            Payment confirmed — this workspace is now fully active. Nothing more to do.
          </p>
        </>
      ) : state === 'slow' ? (
        <>
          <Loader2 size={40} className="mx-auto text-amber-300 animate-spin" />
          <h1 className="page-title">Still confirming…</h1>
          <p className="page-sub">
            The payment went through but confirmation is taking longer than usual.
            It'll land on its own — check back in a minute.
          </p>
        </>
      ) : (
        <>
          <Loader2 size={40} className="mx-auto text-slate-400 animate-spin" />
          <h1 className="page-title">Confirming your payment…</h1>
          <p className="page-sub">This usually takes a few seconds.</p>
        </>
      )}
      <div className="pt-2">
        {customerId ? (
          <Link to={`/customers/${customerId}/billing`} className="btn-primary btn-sm">Go to billing</Link>
        ) : (
          <Link to="/dashboard" className="btn-primary btn-sm">Go to dashboard</Link>
        )}
      </div>
    </div>
  );
}
