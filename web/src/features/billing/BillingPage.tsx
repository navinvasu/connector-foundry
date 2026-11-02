// Billing page — trial → paid conversion for a workspace.
//
// Owners see their current package, pick a paid tier (Stripe Checkout handles
// the card — card details never touch our servers), and manage an existing
// subscription through the Stripe Customer Portal. Editors/viewers can only look.

import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { CreditCard, ExternalLink, Settings2 } from 'lucide-react';
import {
  getBilling, listBillingPlans, startCheckout, openBillingPortal, listInvoices,
  type BillingPlan, type BillingStatus, type Invoice,
} from '../../data/api';
import { Badge, EmptyState, ErrorState, LoadingState } from '../../shared/components/atoms';
import ReadOnlyBanner from '../../shared/components/ReadOnlyBanner';
import { useFoundryStore } from '../../app/store';
import { accessForWorkspace } from '../../data/permissions';
import { resolveListState } from '../../shared/components/page-state';
import { cn } from '../../shared/lib/utils';

const statusTone: Record<string, 'green' | 'amber' | 'red' | 'gray'> = {
  active: 'green', trialing: 'amber', trial_expired: 'red', suspended: 'red',
};

function caps(p: BillingPlan) {
  return [
    `${p.seat_cap} seats`,
    p.project_cap === -1 ? 'unlimited projects' : `${p.project_cap} projects`,
    `${p.telemetry_retention_days}-day telemetry`,
  ].join(' · ');
}

export default function BillingPage() {
  const { id } = useParams<{ id: string }>();
  // FE-09: checkout/portal are owner-only (BE-13) — everyone else looks.
  const access = accessForWorkspace(useFoundryStore((s) => s.me), id);
  const [status, setStatus] = useState<BillingStatus | null>(null);
  const [plans, setPlans] = useState<BillingPlan[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [billingEnabled, setBillingEnabled] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    if (!id) return;
    setLoading(true);
    setErr(null);
    try {
      const [b, p] = await Promise.all([getBilling(id), listBillingPlans()]);
      setStatus(b.billing);
      setPlans(p.plans);
      setBillingEnabled(b.billing_enabled && p.billing_enabled);
      // Invoices are nice-to-have: a 503 (billing not configured) shouldn't
      // blank the rest of the page.
      listInvoices(id).then((inv) => setInvoices(inv.invoices)).catch(() => {});
    } catch (e: any) { setErr(e.message); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, [id]);

  const checkout = async (plan: BillingPlan) => {
    if (!id) return;
    setBusy(plan.id); setErr(null);
    try {
      const { url } = await startCheckout(id, plan.id);
      window.location.href = url; // Stripe-hosted checkout
    } catch (e: any) { setErr(e.message); setBusy(null); }
  };

  const portal = async () => {
    if (!id) return;
    setBusy('portal'); setErr(null);
    try {
      const { url } = await openBillingPortal(id);
      window.location.href = url;
    } catch (e: any) { setErr(e.message); setBusy(null); }
  };

  const trialDays = status?.trial_ends_at
    ? Math.max(0, Math.ceil((new Date(status.trial_ends_at).getTime() - Date.now()) / 86400_000))
    : null;
  // FE-05: packages must not flash "No packages available" mid-load.
  const planState = resolveListState({ loading, error: err, count: plans.length });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="page-title">Billing{status ? ` — ${status.name}` : ''}</h1>
        <p className="page-sub">
          Pick a package, pay by card, and the workspace flips to paid the moment
          Stripe confirms. Plan changes and cancellations are self-serve.
        </p>
      </div>

      {err && planState !== 'error' && (
        <div className="card p-4 text-sm text-red-300 flex flex-wrap items-center gap-3">
          <span>{err}</span>
          <button onClick={() => void load()} className="btn-secondary btn-sm ml-auto">Reload billing</button>
        </div>
      )}

      {!billingEnabled && (
        <div className="card p-4 text-sm text-amber-200/90">
          Billing isn't connected yet — card payments turn on once Stripe is configured on the server.
        </div>
      )}

      <ReadOnlyBanner reason={access.canManageBilling ? null : access.ownerOnlyReason} />

      {status && (
        <div className="card p-5 flex items-center gap-4 flex-wrap">
          <div>
            <div className="micro-label">Current package</div>
            <div className="flex items-center gap-2 mt-1.5">
              <Badge tone={statusTone[status.status] ?? 'gray'}>{status.plan_name}</Badge>
              <span className="text-xs text-slate-400">{status.status.replace('_', ' ')}</span>
            </div>
          </div>
          <div className="ml-auto flex items-center gap-2">
            {status.has_subscription && (
              <button onClick={portal} disabled={busy !== null || !access.canManageBilling} title={access.ownerOnlyReason ?? undefined} className="btn-secondary btn-sm disabled:opacity-40">
                <Settings2 size={14} /> {busy === 'portal' ? 'Opening…' : 'Manage billing'}
              </button>
            )}
          </div>
        </div>
      )}

      {status?.status === 'trialing' && trialDays !== null && (
        <div className="card p-4 text-sm text-amber-200/90">
          Trial ends in {trialDays} day{trialDays === 1 ? '' : 's'}.
          Add a card below to keep this workspace running without interruption —
          you won't be charged until the trial ends.
        </div>
      )}

      {status?.status === 'trial_expired' && (
        <div className="card p-4 text-sm text-red-200/90">
          The trial has expired and this workspace is read-only. Pick a package below to resume.
        </div>
      )}

      {status?.status === 'suspended' && (
        <div className="card p-4 text-sm text-red-200/90">
          This workspace is suspended. Contact support to reactivate it.
        </div>
      )}

      {planState === 'loading' ? (
        <LoadingState label="Loading packages…" />
      ) : planState === 'error' ? (
        <ErrorState message={`Couldn't load packages: ${err}`} onRetry={() => void load()} />
      ) : planState === 'empty' ? (
        <EmptyState title="No packages available" sub="The server isn't returning any purchasable packages yet." />
      ) : (
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {plans.map((p) => {
          const current = status?.plan_id === p.id;
          return (
            <div key={p.id} className={cn('card p-5 flex flex-col', current && 'ring-1 ring-emerald-500/40')}>
              <div className="flex items-center justify-between">
                <div className="font-medium">{p.name}</div>
                {current && <Badge tone="green">Current</Badge>}
              </div>
              <div className="text-2xl font-semibold mt-2">
                {p.price_display ?? <span className="text-base text-slate-400">Pricing to be announced</span>}
              </div>
              <div className="text-xs text-slate-400 mt-2">{caps(p)}</div>
              <div className="mt-4 pt-2">
                {current ? (
                  <span className="text-xs text-slate-500">You're on this package.</span>
                ) : status?.has_subscription ? (
                  <span className="text-xs text-slate-500">Use "Manage billing" above to switch packages.</span>
                ) : (
                  <button
                    onClick={() => checkout(p)}
                    disabled={!billingEnabled || !p.purchasable || busy !== null || status?.status === 'suspended' || !access.canManageBilling}
                    className="btn-primary btn-sm disabled:opacity-40"
                    title={!access.canManageBilling ? (access.ownerOnlyReason ?? undefined) : !p.purchasable ? 'This package has no Stripe price configured yet' : undefined}
                  >
                    <CreditCard size={14} />
                    {busy === p.id ? 'Redirecting…' : status?.status === 'trial_expired' ? 'Resume with this package' : 'Choose package'}
                  </button>
                )}
              </div>
              {!p.purchasable && (
                <div className="text-[11px] text-amber-200/60 mt-2">
                  Not purchasable yet — no Stripe price is configured for this tier.
                </div>
              )}
            </div>
          );
        })}
      </div>
      )}

      {status?.has_subscription && (
        <div className="card p-5">
          <div className="micro-label mb-3">Invoice history</div>
          {invoices.length === 0 ? (
            <div className="text-sm text-slate-500">No invoices yet.</div>
          ) : (
            <div className="divide-y divide-slate-800/60">
              {invoices.map((inv) => (
                <div key={inv.id} className="py-2.5 flex items-center gap-3 text-sm">
                  <span className="text-slate-400">{inv.number ?? inv.id}</span>
                  <span className="text-slate-500 text-xs">
                    {new Date(inv.created).toLocaleDateString()}
                  </span>
                  <span className="ml-auto font-medium">
                    {(inv.amount_due / 100).toFixed(2)} {inv.currency.toUpperCase()}
                  </span>
                  <Badge tone={inv.status === 'paid' ? 'green' : 'amber'}>
                    {inv.status ?? 'unknown'}
                  </Badge>
                  {inv.hosted_url && (
                    <a href={inv.hosted_url} target="_blank" rel="noreferrer"
                       className="text-xs text-slate-400 hover:text-slate-200 underline underline-offset-2">
                      Receipt
                    </a>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="text-[11px] text-slate-500 flex items-center gap-1">
        <ExternalLink size={11} /> Payments are processed securely by Stripe. We never see your card number.
      </div>
    </div>
  );
}
