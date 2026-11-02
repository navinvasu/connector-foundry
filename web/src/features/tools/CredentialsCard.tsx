import { useCallback, useEffect, useState } from 'react';
import { KeyRound } from 'lucide-react';
import {
  listCredentials,
  saveCredential,
  rotateCredential,
  revokeCredential,
  type CredentialMeta,
} from '../../data/api';
import { useProjectAccess } from '../../app/store';

/**
 * Item 5 — the missing "where do I save the API key" surface. The secret is
 * written once to the server vault and never read back: this card only ever
 * shows key metadata (label, fingerprint, created/rotated dates).
 */
export default function CredentialsCard({ projectId }: { projectId: string }) {
  const access = useProjectAccess();
  const [creds, setCreds] = useState<CredentialMeta[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [label, setLabel] = useState('');
  const [value, setValue] = useState('');
  const [replacing, setReplacing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await listCredentials(projectId);
      setCreds(res.credentials);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoaded(true);
    }
  }, [projectId]);

  useEffect(() => {
    setLoaded(false);
    setCreds([]);
    setError(null);
    void refresh();
  }, [refresh]);

  const active = creds.find((c) => c.status === 'active');

  const run = async (fn: () => Promise<unknown>, clearForm = true) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await refresh();
      if (clearForm) {
        setLabel('');
        setValue('');
        setReplacing(false);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleSave = () =>
    run(() => saveCredential(projectId, label.trim() || 'default', value));

  const handleRotate = () =>
    active ? run(() => rotateCredential(projectId, active.id, value)) : Promise.resolve();

  const handleRevoke = () =>
    active && window.confirm(`Revoke the API key "${active.label}"? Live evaluation will fail until a new key is saved.`)
      ? run(() => revokeCredential(projectId, active.id), false)
      : Promise.resolve();

  if (!loaded) return null;

  return (
    <div className="card p-4">
      <div className="flex items-center gap-2 mb-1">
        <KeyRound size={16} className="text-orange-300" />
        <h2 className="font-semibold">Upstream API key</h2>
      </div>
      <p className="text-xs text-slate-400 mb-3">
        Saved once to the server vault and never shown again — evaluations against the live
        upstream use this key. Only metadata is listed here.
      </p>

      {active && !replacing ? (
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span className="mono font-medium">{active.label}</span>
          {active.key_fingerprint && (
            <span className="mono text-xs text-slate-400">…{active.key_fingerprint.slice(-8)}</span>
          )}
          <span className="text-xs text-slate-500">
            saved {new Date(active.created_at).toLocaleDateString()}
            {active.rotated_at && ` · rotated ${new Date(active.rotated_at).toLocaleDateString()}`}
          </span>
          <span className="flex-1" />
          <button className="btn-sm btn-secondary" disabled={!access.canEdit || busy} onClick={() => setReplacing(true)} title={access.readOnlyReason ?? 'Replace with a new key'}>
            Rotate
          </button>
          <button className="btn-sm btn-secondary" disabled={!access.canEdit || busy} onClick={() => void handleRevoke()} title={access.readOnlyReason ?? 'Delete this key'}>
            Revoke
          </button>
        </div>
      ) : (
        <div className="flex flex-wrap items-end gap-2">
          {(!active || replacing) && active && (
            <p className="w-full text-xs text-amber-300">
              {replacing ? `Replacing "${active.label}" — the old key stops working immediately.`
                : `A key ("${active.label}") is already saved. Saving again is rejected — rotate instead.`}
            </p>
          )}
          {!active && !replacing && (
            <div className="w-full sm:w-48">
              <label className="label" htmlFor="cred-label">Label</label>
              <input
                id="cred-label"
                className="input"
                placeholder="API Key Label"
                value={label}
                disabled={!access.canEdit || busy}
                onChange={(e) => setLabel(e.target.value)}
              />
            </div>
          )}
          <div className="flex-1 min-w-52">
            <label className="label" htmlFor="cred-value">API key</label>
            <input
              id="cred-value"
              className="input mono"
              type="password"
              autoComplete="new-password"
              placeholder="Paste the upstream API key"
              value={value}
              disabled={!access.canEdit || busy}
              onChange={(e) => setValue(e.target.value)}
            />
          </div>
          <button
            className="btn-sm btn-primary"
            disabled={!access.canEdit || busy || value.trim().length === 0}
            onClick={() => void (replacing ? handleRotate() : handleSave())}
            title={access.readOnlyReason ?? undefined}
          >
            {replacing ? 'Save new key' : 'Save key'}
          </button>
          {replacing && (
            <button className="btn-sm btn-secondary" disabled={busy} onClick={() => { setReplacing(false); setValue(''); }}>
              Cancel
            </button>
          )}
        </div>
      )}

      {error && (
        <p className="text-xs text-red-300 mt-2">
          {error}
          {error.includes('credential_storage_not_configured') &&
            ' — the server has no vault key (CF_BROKER_DEV_KEY). Set it and restart the backend.'}
        </p>
      )}
    </div>
  );
}
