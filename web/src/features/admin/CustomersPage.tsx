import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Building2, Plus, Users, X } from 'lucide-react';
import {
  listCustomers, listPlans, createCustomer, updateCustomer,
  suspendCustomer, reactivateCustomer, adjustCustomerSeats, trialDaysLeft,
  type Customer, type Plan,
} from '../../data/api';
import { Badge, EmptyState, ErrorState, LoadingState, ProgressBar, SectionHeader } from '../../shared/components/atoms';
import { resolveListState } from '../../shared/components/page-state';
import { cn } from '../../shared/lib/utils';

const statusTone: Record<Customer['status'], 'amber' | 'green' | 'red' | 'gray'> = {
  trialing: 'amber',
  active: 'green',
  trial_expired: 'red',
  suspended: 'gray',
};

const statusLabel: Record<Customer['status'], string> = {
  trialing: 'Trial',
  active: 'Active',
  trial_expired: 'Trial expired',
  suspended: 'Suspended',
};

function CustomerCard({ customer, plans, onChanged }: {
  customer: Customer; plans: Plan[]; onChanged: () => void;
}) {
  const navigate = useNavigate();
  const [err, setErr] = useState<string | null>(null);
  const [showSeats, setShowSeats] = useState(false);
  const days = trialDaysLeft(customer);
  const seatPct = customer.seat_cap > 0 ? (customer.seats_used / customer.seat_cap) * 100 : 0;
  const planSeatCap = plans.find((p) => p.id === customer.plan_id)?.seat_cap;

  const act = async (fn: () => Promise<unknown>) => {
    setErr(null);
    try { await fn(); onChanged(); }
    catch (e: any) { setErr(e.message); }
  };

  return (
    <div className="card panel-glow p-5 flex flex-col gap-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="font-display text-lg font-semibold text-white">{customer.name}</div>
          <div className="text-xs text-slate-500 font-mono mt-0.5">
            {customer.slug ?? customer.id.slice(0, 8)} · since {new Date(customer.created_at).toLocaleDateString()}
          </div>
        </div>
        <div className="flex gap-1.5 shrink-0">
          <Badge tone="blue">{customer.plan_name}</Badge>
          <Badge tone={statusTone[customer.status]}>{statusLabel[customer.status]}</Badge>
        </div>
      </div>

      {days !== null && (
        <div className="text-xs text-amber-200/80">
          Trial ends in <span className="font-semibold text-amber-100">{days} day{days === 1 ? '' : 's'}</span>
        </div>
      )}
      {customer.status === 'trial_expired' && (
        <div className="text-xs text-red-300/80">Trial expired — workspace is read-only until they convert to a paid plan.</div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="rounded-lg bg-white/5 border border-white/10 px-3 py-2.5">
          <div className="micro-label">Seats</div>
          <div className="font-display text-xl text-white mt-0.5">
            {customer.seats_used}<span className="text-slate-500 text-sm">/{customer.seat_cap}</span>
          </div>
          <ProgressBar value={seatPct} tone={seatPct >= 100 ? 'red' : seatPct >= 80 ? 'amber' : 'brand'} />
          {customer.seat_override != null && (
            <div className="text-[11px] text-slate-500 mt-1">
              Staff-granted total{planSeatCap != null ? ` · plan default ${planSeatCap}` : ''}
            </div>
          )}
        </div>
        <div className="rounded-lg bg-white/5 border border-white/10 px-3 py-2.5">
          <div className="micro-label">Projects</div>
          <div className="font-display text-xl text-white mt-0.5">
            {customer.projects_used}
            <span className="text-slate-500 text-sm">/{customer.project_cap === -1 ? '∞' : customer.project_cap}</span>
          </div>
          <div className="text-[11px] text-slate-500 mt-1">{customer.telemetry_retention_days}-day telemetry</div>
        </div>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <label className="text-[11px] text-slate-500">Plan</label>
        <select
          value={customer.plan_id}
          onChange={(e) => act(() => updateCustomer(customer.id, { plan_id: e.target.value }))}
          className="input !w-auto !py-1.5 !px-2.5 text-xs"
        >
          {plans.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
        <div className="ml-auto flex gap-2">
          <button onClick={() => navigate(`/customers/${customer.id}/users`)} className="btn-secondary btn-sm">
            <Users size={14} /> Users
          </button>
          <button onClick={() => setShowSeats(true)} className="btn-secondary btn-sm">
            Adjust seats
          </button>
          {customer.status === 'suspended' ? (
            <button onClick={() => act(() => reactivateCustomer(customer.id))} className="btn-primary btn-sm">
              Reactivate
            </button>
          ) : (
            <button onClick={() => act(() => suspendCustomer(customer.id))} className="btn-secondary btn-sm !text-red-300">
              Suspend
            </button>
          )}
        </div>
      </div>
      {err && <div className="text-xs text-red-300">{err}</div>}
      {showSeats && (
        <AdjustSeatsDialog
          customer={customer}
          planSeatCap={planSeatCap}
          onClose={() => setShowSeats(false)}
          onDone={() => { setShowSeats(false); onChanged(); }}
        />
      )}
    </div>
  );
}

/** BL-05: staff set a customer's TOTAL seat cap (or clear back to plan). */
function AdjustSeatsDialog({ customer, planSeatCap, onClose, onDone }: {
  customer: Customer; planSeatCap?: number; onClose: () => void; onDone: () => void;
}) {
  const [useDefault, setUseDefault] = useState(customer.seat_override == null);
  const [seats, setSeats] = useState(String(customer.seat_cap));
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const parsed = Number.parseInt(seats, 10);
  const valid = useDefault || (Number.isInteger(parsed) && parsed >= 1);

  const submit = async () => {
    setBusy(true);
    setErr(null);
    try {
      await adjustCustomerSeats(customer.id, useDefault ? null : parsed, reason.trim() || undefined);
      onDone();
    } catch (e: any) { setErr(e.message); setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="card w-full max-w-md p-6 space-y-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between">
          <div>
            <h2 className="font-display text-lg font-semibold text-white">Adjust seats</h2>
            <p className="text-xs text-slate-500 mt-0.5">{customer.name} · {customer.seats_used} in use</p>
          </div>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-300"><X size={18} /></button>
        </div>

        <label className="flex items-center gap-2 text-sm text-slate-300">
          <input type="checkbox" checked={useDefault} onChange={(e) => setUseDefault(e.target.checked)} />
          Use plan default{planSeatCap != null ? ` (${planSeatCap} seats)` : ''}
        </label>

        {!useDefault && (
          <div>
            <label className="micro-label">Total seats for this customer</label>
            <input
              type="number" min={1} value={seats}
              onChange={(e) => setSeats(e.target.value)}
              className="input mt-1" placeholder="e.g. 15"
            />
            <p className="text-[11px] text-slate-500 mt-1">
              A total, not an add-on. Setting it below current usage removes nobody —
              invites simply block until the team is under the cap.
            </p>
          </div>
        )}

        <div>
          <label className="micro-label">Reason (audit log)</label>
          <input
            value={reason} onChange={(e) => setReason(e.target.value)}
            className="input mt-1" placeholder="e.g. pilot program, good-will" maxLength={500}
          />
        </div>

        {customer.seat_override != null && (
          <p className="text-[11px] text-slate-500">
            Current override: {customer.seat_override} seats
            {customer.seat_override_by ? ` by ${customer.seat_override_by}` : ''}
            {customer.seat_override_reason ? ` — “${customer.seat_override_reason}”` : ''}
          </p>
        )}

        {err && <div className="text-xs text-red-300">{err}</div>}
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="btn-secondary btn-sm">Cancel</button>
          <button onClick={submit} disabled={busy || !valid} className="btn-primary btn-sm disabled:opacity-40">
            Save seats
          </button>
        </div>
      </div>
    </div>
  );
}

function OnboardDialog({ plans, onClose, onDone }: {
  plans: Plan[]; onClose: () => void; onDone: () => void;
}) {
  const [name, setName] = useState('');
  const [planId, setPlanId] = useState('trial');
  const [ownerEmail, setOwnerEmail] = useState('');
  const [ownerName, setOwnerName] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!name.trim()) { setErr('Customer name is required.'); return; }
    setBusy(true); setErr(null);
    try {
      await createCustomer({
        name: name.trim(),
        plan_id: planId,
        owner_email: ownerEmail.trim() || undefined,
        owner_name: ownerName.trim() || undefined,
      });
      onDone();
    } catch (e: any) { setErr(e.message); }
    finally { setBusy(false); }
  };

  const plan = plans.find((p) => p.id === planId);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative card p-6 w-full max-w-md space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="font-display text-lg font-semibold text-white">Onboard customer</h2>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-300"><X size={18} /></button>
        </div>
        <div>
          <div className="micro-label mb-1.5">Company name</div>
          <input value={name} onChange={(e) => setName(e.target.value)} className="input w-full"
            placeholder="Acme Corp" autoFocus />
        </div>
        <div>
          <div className="micro-label mb-1.5">Package</div>
          <select value={planId} onChange={(e) => setPlanId(e.target.value)} className="input w-full">
            {plans.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} — {p.seat_cap} seats · {p.project_cap === -1 ? '∞' : p.project_cap} projects
                {p.is_trial ? ` · ${p.trial_duration_days}-day trial` : ''}
              </option>
            ))}
          </select>
          {plan?.is_trial && (
            <p className="text-[11px] text-amber-200/70 mt-1.5">
              Starts a {plan.trial_duration_days}-day trial clock. The workspace becomes read-only when it expires.
            </p>
          )}
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <div className="micro-label mb-1.5">Owner email</div>
            <input value={ownerEmail} onChange={(e) => setOwnerEmail(e.target.value)} className="input w-full"
              placeholder="owner@acme.com" type="email" />
          </div>
          <div>
            <div className="micro-label mb-1.5">Owner name</div>
            <input value={ownerName} onChange={(e) => setOwnerName(e.target.value)} className="input w-full"
              placeholder="Jane Doe" />
          </div>
        </div>
        <p className="text-[11px] text-slate-500 leading-relaxed">
          The owner signs in with Cognito and is linked by email on first login. Until then the
          membership sits ready for them.
        </p>
        {err && <div className="text-xs text-red-300">{err}</div>}
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="btn-secondary btn-sm">Cancel</button>
          <button onClick={submit} disabled={busy} className="btn-primary btn-sm disabled:opacity-40">
            <Plus size={14} /> {busy ? 'Onboarding…' : 'Onboard customer'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function CustomersPage() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [showDialog, setShowDialog] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    setErr(null);
    try {
      const [c, p] = await Promise.all([listCustomers(), listPlans()]);
      setCustomers(c.customers);
      setPlans(p.plans);
    } catch (e: any) { setErr(e.message); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  // FE-05: loading / error / empty share one contract (resolveListState) —
  // "No customers yet" used to flash before the first load finished.
  const listState = resolveListState({ loading, error: err, count: customers.length });

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="page-title">Customers</h1>
          <p className="page-sub">
            Onboard companies, assign packages, run trials, and suspend workspaces. Platform-admin only.
          </p>
        </div>
        <button onClick={() => setShowDialog(true)} className="btn-primary btn-sm">
          <Plus size={14} /> Onboard customer
        </button>
      </div>

      {listState === 'error' ? (
        <ErrorState message={`Couldn't load customers: ${err}`} onRetry={() => void load()} />
      ) : listState === 'loading' ? (
        <LoadingState label="Loading customers…" />
      ) : listState === 'empty' ? (
        <EmptyState
          title="No customers yet."
          sub="Onboard your first customer — pick a package, optionally start a trial, and add their owner."
          action={
            <button onClick={() => setShowDialog(true)} className="btn-primary btn-sm">
              <Plus size={14} /> Onboard customer
            </button>
          }
        />
      ) : (
        <>
          <SectionHeader index="01 · Registry" title="All customers" hint={`${customers.length} CUSTOMERS`} />
          <div className="grid md:grid-cols-2 gap-4">
            {customers.map((c) => (
              <CustomerCard key={c.id} customer={c} plans={plans} onChanged={load} />
            ))}
          </div>
        </>
      )}

      <div className={cn('card p-5 flex items-center gap-4', 'opacity-80')}>
        <Building2 size={18} className="text-neon shrink-0" />
        <div className="text-sm text-slate-400">
          Packages are defined in the <span className="text-slate-200 font-medium">plans</span> table —
          seat caps, project caps, and telemetry retention change there, not in code.
        </div>
      </div>

      {showDialog && (
        <OnboardDialog plans={plans} onClose={() => setShowDialog(false)} onDone={() => { setShowDialog(false); load(); }} />
      )}
    </div>
  );
}
