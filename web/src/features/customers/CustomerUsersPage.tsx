import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { MailPlus, Trash2, CreditCard } from 'lucide-react';
import {
  getCustomer, listMembers, inviteMember, updateMember, removeMember, isSoleActiveOwner,
  trialDaysLeft, type Customer, type Member, type Usage,
} from '../../data/api';
import { Badge, EmptyState, ErrorState, LoadingState, ProgressBar, SectionHeader } from '../../shared/components/atoms';
import ReadOnlyBanner from '../../shared/components/ReadOnlyBanner';
import { useFoundryStore } from '../../app/store';
import { accessForWorkspace } from '../../data/permissions';
import { resolveListState } from '../../shared/components/page-state';
import { cn } from '../../shared/lib/utils';

const roleTone: Record<Member['role'], 'purple' | 'blue' | 'gray'> = {
  owner: 'purple', editor: 'blue', viewer: 'gray',
};

const statusTone: Record<string, 'green' | 'amber' | 'red' | 'gray'> = {
  active: 'green', invited: 'amber', suspended: 'red',
};

export default function CustomerUsersPage() {
  const { id } = useParams<{ id: string }>();
  // FE-09: inviting, re-roling, and removing members are owner-only
  // (BE-13); editors/viewers see the roster read-only. Platform admins
  // keep full control via the bypass in accessForWorkspace.
  const access = accessForWorkspace(useFoundryStore((s) => s.me), id);
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('viewer');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    if (!id) return;
    setLoading(true);
    setErr(null);
    try {
      const [c, m] = await Promise.all([getCustomer(id), listMembers(id)]);
      setCustomer(c.customer);
      setMembers(m.members);
      setUsage(m.usage);
    } catch (e: any) { setErr(e.message); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, [id]);

  const invite = async () => {
    if (!id || !email.trim()) return;
    setBusy(true); setErr(null);
    try {
      await inviteMember(id, { email: email.trim(), role });
      setEmail('');
      await load();
    } catch (e: any) { setErr(e.message); }
    finally { setBusy(false); }
  };

  const changeRole = async (m: Member, next: string) => {
    if (!id) return;
    setErr(null);
    try { await updateMember(id, m.user_id, { role: next }); await load(); }
    catch (e: any) { setErr(e.message); }
  };

  const remove = async (m: Member) => {
    if (!id) return;
    if (!window.confirm(`Remove ${m.email} from this workspace?`)) return;
    setErr(null);
    try { await removeMember(id, m.user_id); await load(); }
    catch (e: any) { setErr(e.message); }
  };

  const days = customer ? trialDaysLeft(customer) : null;
  const seatPct = usage && usage.seat_cap > 0 ? (usage.seats_used / usage.seat_cap) * 100 : 0;
  // FE-05: shared list contract — "No users yet" must not flash while the
  // roster is still loading, and a failed first load gets a retry instead.
  const memberState = resolveListState({ loading, error: err, count: members.length });

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="page-title">{customer ? customer.name : 'Workspace users'}</h1>
          <p className="page-sub">
            Invite teammates, assign roles, and manage seats. Owners can do everything here;
            editors and viewers can only look.
          </p>
        </div>
        {customer && (
          <Link to={`/customers/${customer.id}/billing`} className="btn-secondary btn-sm mt-1">
            <CreditCard size={14} /> Billing
          </Link>
        )}
      </div>

      {err && members.length > 0 ? (
        <div className="card p-4 text-sm text-red-300 flex flex-wrap items-center gap-3">
          <span>{err}</span>
          <button onClick={() => void load()} className="btn-secondary btn-sm ml-auto">Retry</button>
        </div>
      ) : null}

      {customer?.status === 'trialing' && days !== null && (
        <div className="card p-4 text-sm text-amber-200/90 flex items-center gap-3 flex-wrap">
          <span>Trial ends in {days} day{days === 1 ? '' : 's'} — add a card to keep this workspace running.</span>
          <Link to={`/customers/${customer.id}/billing`} className="btn-primary btn-sm ml-auto">Add payment method</Link>
        </div>
      )}

      {customer?.status === 'trial_expired' && (
        <div className="card p-4 text-sm text-red-200/90 flex items-center gap-3 flex-wrap">
          <span>Trial expired — this workspace is read-only until you pick a package.</span>
          <Link to={`/customers/${customer.id}/billing`} className="btn-primary btn-sm ml-auto">Resume with a package</Link>
        </div>
      )}

      {customer && (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          <div className="card p-4">
            <div className="micro-label">Package</div>
            <div className="flex items-center gap-2 mt-1.5">
              <Badge tone="blue">{customer.plan_name}</Badge>
              {days !== null && <span className="text-xs text-amber-200/80">{days}d trial left</span>}
            </div>
          </div>
          <div className="card p-4">
            <div className="micro-label">Seats · {usage?.seats_used}/{usage?.seat_cap}</div>
            <div className="mt-2"><ProgressBar value={seatPct} tone={seatPct >= 100 ? 'red' : seatPct >= 80 ? 'amber' : 'brand'} /></div>
            {usage?.seat_override != null && (
              <div className="text-[11px] text-slate-500 mt-1.5">
                Includes a staff-granted seat total (plan default {usage.plan_seat_cap}).
              </div>
            )}
            {usage && usage.seats_used >= usage.seat_cap && (
              <div className="text-[11px] text-amber-200/70 mt-1.5">Seat limit reached — upgrade the package to invite more.</div>
            )}
          </div>
          <div className="card p-4">
            <div className="micro-label">Projects · {usage?.projects_used}/{usage && usage.project_cap === -1 ? '∞' : usage?.project_cap}</div>
            <div className="text-[11px] text-slate-500 mt-2">{customer.telemetry_retention_days}-day telemetry retention</div>
          </div>
        </div>
      )}

      <ReadOnlyBanner reason={access.canManageTeam ? null : access.ownerOnlyReason} />

      <div className="card p-5">
        <div className="micro-label mb-3">Invite a teammate</div>
        <div className="flex gap-2 flex-wrap">
          <input
            value={email} onChange={(e) => setEmail(e.target.value)} type="email"
            placeholder="teammate@company.com" className="input flex-1 min-w-[220px]"
            disabled={!access.canManageTeam}
            onKeyDown={(e) => e.key === 'Enter' && invite()}
          />
          <select value={role} onChange={(e) => setRole(e.target.value)} className="input !w-auto" disabled={!access.canManageTeam}>
            <option value="viewer">Viewer — read-only</option>
            <option value="editor">Editor — build & publish</option>
            <option value="owner">Owner — manage users & billing</option>
          </select>
          <button onClick={invite} disabled={busy || !email.trim() || !access.canManageTeam} title={access.ownerOnlyReason ?? undefined} className="btn-primary btn-sm disabled:opacity-40">
            <MailPlus size={14} /> {busy ? 'Inviting…' : 'Send invite'}
          </button>
        </div>
        <p className="text-[11px] text-slate-500 mt-2 leading-relaxed">
          They sign in with Cognito and are matched to this workspace by email on first login.
        </p>
      </div>

      {memberState === 'loading' ? (
        <LoadingState label="Loading workspace users…" />
      ) : memberState === 'error' ? (
        <ErrorState message={`Couldn't load workspace users: ${err}`} onRetry={() => void load()} />
      ) : members.length === 0 ? (
        <EmptyState title="No users yet." sub="Invite the first teammate above." />
      ) : (
        <>
          <SectionHeader index="01 · Roster" title="Users" hint={`${members.length} MEMBERS`} />
          <div className="card divide-y divide-white/5">
            {members.map((m) => (
              <div key={m.membership_id} className="flex items-center gap-3 px-5 py-3.5 flex-wrap">
                <div className="w-9 h-9 rounded-full bg-neon/15 border border-neon/30 text-neon flex items-center justify-center text-sm font-semibold shrink-0">
                  {(m.full_name ?? m.email).charAt(0).toUpperCase()}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-slate-100 truncate">{m.full_name ?? m.email}</div>
                  <div className="text-xs text-slate-500 truncate">
                    {m.full_name ? `${m.email} · ` : ''}
                    {m.status === 'invited' ? 'invited' : m.last_login_at ? `last active ${new Date(m.last_login_at).toLocaleDateString()}` : 'never signed in'}
                    {m.status === 'invited' && m.invite_expires_at && ` · invite expires ${new Date(m.invite_expires_at).toLocaleDateString()}`}
                  </div>
                </div>
                <Badge tone={statusTone[m.status] ?? 'gray'}>{m.status}</Badge>
                <select
                  value={m.role}
                  onChange={(e) => changeRole(m, e.target.value)}
                  disabled={!access.canManageTeam || isSoleActiveOwner(members, m)}
                  title={!access.canManageTeam ? (access.ownerOnlyReason ?? undefined) : isSoleActiveOwner(members, m) ? 'The last active owner can’t be demoted — make another member an owner first' : undefined}
                  className={cn('input !w-auto !py-1.5 !px-2.5 text-xs disabled:opacity-40')}
                  aria-label={`Role for ${m.email}`}
                >
                  <option value="viewer">Viewer</option>
                  <option value="editor">Editor</option>
                  <option value="owner">Owner</option>
                </select>
                <Badge tone={roleTone[m.role]}>{m.role}</Badge>
                <button
                  onClick={() => remove(m)}
                  disabled={!access.canManageTeam || isSoleActiveOwner(members, m)}
                  title={!access.canManageTeam ? (access.ownerOnlyReason ?? undefined) : isSoleActiveOwner(members, m) ? 'The last active owner can’t be removed — make another member an owner first' : undefined}
                  className="text-slate-500 hover:text-red-300 transition-colors p-1.5 disabled:opacity-40 disabled:hover:text-slate-500"
                  aria-label={`Remove ${m.email}`}
                >
                  <Trash2 size={16} />
                </button>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
