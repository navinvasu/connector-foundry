// Gateway API keys panel (DP-07) — Run plane (Operate).
//
// Scripts, MCP clients, and GPT Actions call this project's released
// connector with a key (`Authorization: Bearer cf_live_…` or
// `X-API-Key: cf_live_…`) instead of a human login. Minting shows the
// secret exactly once; the list only ever carries the display prefix.
// Viewers see the list read-only (the API remains the real gate).
import { useCallback, useEffect, useState } from 'react';
import { Check, Copy, KeyRound, Plus, Trash2 } from 'lucide-react';
import {
  listGatewayKeys, createGatewayKey, revokeGatewayKey,
  type GatewayKey,
} from '../../data/api';
import { useFoundryStore } from '../../app/store';
import { Badge, EmptyState, ErrorState, LoadingState, SectionHeader } from '../../shared/components/atoms';
import {
  gatewayKeyStatus, gatewayKeyExpiryLabel, canManageKeys, EXPIRY_OPTIONS, expiryIsoFor,
} from './gatewayKeys';

export default function GatewayKeysPanel() {
  const liveProjectId = useFoundryStore((s) => s.activeProjectId);

  const [keys, setKeys] = useState<GatewayKey[] | null>(null);
  const [callerRole, setCallerRole] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [expiry, setExpiry] = useState<string>('never');
  const [busy, setBusy] = useState(false);
  const [freshSecret, setFreshSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    if (!liveProjectId) return;
    setError(null);
    try {
      const r = await listGatewayKeys(liveProjectId);
      setKeys(r.api_keys);
      setCallerRole(r.caller_role);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [liveProjectId]);

  useEffect(() => {
    if (liveProjectId) {
      setKeys(null);
      load().catch(() => {});
    }
  }, [liveProjectId, load]);

  if (!liveProjectId) return null;
  const manage = canManageKeys(callerRole);

  const mint = async () => {
    if (!label.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const created = await createGatewayKey(liveProjectId, {
        label: label.trim(),
        expires_at: expiryIsoFor(expiry),
      });
      setFreshSecret(created.secret);
      setCopied(false);
      setLabel('');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (key: GatewayKey) => {
    setBusy(true);
    setError(null);
    try {
      await revokeGatewayKey(liveProjectId, key.id);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card-pad">
      <SectionHeader
        title="Gateway API keys"
        sub="Keys let scripts and agent clients invoke this project's released connector without a human login. Send as Authorization: Bearer or X-API-Key."
        action={<Badge tone="purple">Data plane</Badge>}
      />

      {error && <ErrorState message={`Gateway keys: ${error}`} onRetry={() => load().catch(() => {})} />}

      {freshSecret && (
        <div className="rounded-xl border border-amber-400/30 bg-amber-400/10 px-4 py-3 mb-4">
          <p className="text-sm font-medium text-amber-200 mb-1">Copy your new key now — it won't be shown again.</p>
          <div className="flex items-center gap-2">
            <code className="text-xs text-amber-100 break-all flex-1">{freshSecret}</code>
            <button
              type="button"
              className="btn btn-sm btn-secondary shrink-0"
              onClick={() => {
                navigator.clipboard?.writeText(freshSecret).catch(() => {});
                setCopied(true);
              }}
            >
              {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? 'Copied' : 'Copy'}
            </button>
            <button type="button" className="btn btn-sm btn-secondary shrink-0" onClick={() => setFreshSecret(null)}>
              Done
            </button>
          </div>
        </div>
      )}

      {keys === null && !error ? (
        <LoadingState label="Loading API keys…" />
      ) : keys && keys.length === 0 ? (
        <EmptyState
          title="No gateway keys yet"
          sub={manage
            ? 'Mint a key so scripts and agent clients can invoke this connector.'
            : 'Ask an owner or editor to mint a key for this project.'}
        />
      ) : (
        <div className="space-y-2 mb-4">
          {(keys ?? []).map((k) => {
            const st = gatewayKeyStatus(k);
            return (
              <div key={k.id} className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/5 px-3.5 py-2.5">
                <KeyRound size={15} className="text-neon shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-slate-200 truncate">{k.label}</p>
                  <p className="text-xs text-slate-400">
                    <code>{k.prefix}…</code> · {gatewayKeyExpiryLabel(k)}
                    {k.last_used_at ? ` · last used ${new Date(k.last_used_at).toLocaleDateString('en-US')}` : ' · never used'}
                  </p>
                </div>
                <Badge tone={st.tone}>{st.label}</Badge>
                {manage && k.status === 'active' && (
                  <button
                    type="button"
                    className="btn btn-sm btn-secondary shrink-0"
                    disabled={busy}
                    onClick={() => revoke(k)}
                    title="Revoke this key (it stops working immediately)"
                  >
                    <Trash2 size={13} /> Revoke
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {manage ? (
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex-1 min-w-48">
            <span className="text-xs text-slate-400 block mb-1">Key label</span>
            <input
              className="input w-full"
              placeholder="e.g. production script"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              maxLength={120}
            />
          </label>
          <label>
            <span className="text-xs text-slate-400 block mb-1">Expiry</span>
            <select className="input !w-auto" value={expiry} onChange={(e) => setExpiry(e.target.value)}>
              {EXPIRY_OPTIONS.map((o) => (
                <option key={o.id} value={o.id}>{o.label}</option>
              ))}
            </select>
          </label>
          <button type="button" className="btn btn-sm" disabled={busy || !label.trim()} onClick={mint}>
            <Plus size={13} /> Mint key
          </button>
        </div>
      ) : (
        keys !== null && (
          <p className="text-xs text-slate-400">Viewers can see keys but not mint or revoke them.</p>
        )
      )}
    </div>
  );
}
