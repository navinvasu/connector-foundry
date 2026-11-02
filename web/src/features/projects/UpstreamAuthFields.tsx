import { ExternalLink, KeyRound } from 'lucide-react';
import { UPSTREAM_AUTH_OPTIONS, type UpstreamAuthMode } from '../../data/projects';
import { cn } from '../../shared/lib/utils';

/** Upstream authentication picker — API key (live) or access token via
 *  browser login (disabled for the demo). The key field and the login-URI
 *  field are controlled by the caller so both onboarding wizards and the
 *  project detail page share one presentation. Nothing here writes to the
 *  server; callers save through the credentials API. */
export default function UpstreamAuthFields({
  mode,
  onMode,
  apiKey,
  onApiKey,
  loginUri,
  onLoginUri,
  disabled,
  keyInputId,
  loginInputId,
}: {
  mode: UpstreamAuthMode;
  onMode: (m: UpstreamAuthMode) => void;
  apiKey: string;
  onApiKey: (v: string) => void;
  loginUri: string;
  onLoginUri: (v: string) => void;
  disabled?: boolean;
  keyInputId: string;
  loginInputId: string;
}) {
  return (
    <div className="space-y-3">
      {UPSTREAM_AUTH_OPTIONS.map((opt) => {
        const selected = mode === opt.id;
        const locked = Boolean(opt.disabled) || Boolean(disabled);
        return (
          <div
            key={opt.id}
            className={cn(
              'rounded-xl border p-4 transition-colors',
              opt.disabled && 'opacity-60',
              selected && !opt.disabled
                ? 'border-neon bg-neon/10 ring-1 ring-neon'
                : 'border-white/10',
              !locked && 'cursor-pointer hover:border-white/25',
            )}
            role="radio"
            aria-checked={selected}
            aria-disabled={locked}
            onClick={() => { if (!locked) onMode(opt.id); }}
          >
            <div className="flex items-center gap-2">
              {opt.id === 'api_key'
                ? <KeyRound size={17} className={selected ? 'text-neon' : 'text-slate-400'} />
                : <ExternalLink size={17} className="text-slate-500" />}
              <span className="text-sm font-medium text-slate-100">{opt.label}</span>
              {opt.disabled
                ? <span className="badge badge-gray !text-[10px] ml-auto">Demo: disabled</span>
                : selected && <span className="badge badge-blue !text-[10px] ml-auto">Selected</span>}
            </div>
            <p className="text-xs text-slate-500 mt-1.5 leading-relaxed">{opt.desc}</p>
            {opt.disabled && opt.disabledNote && (
              <p className="text-xs text-amber-300/90 mt-1.5">{opt.disabledNote}</p>
            )}

            {opt.id === 'api_key' && selected && (
              <div className="mt-3" onClick={(e) => e.stopPropagation()}>
                <label className="label" htmlFor={keyInputId}>Upstream API key</label>
                <input
                  id={keyInputId}
                  className="input mono"
                  type="password"
                  autoComplete="new-password"
                  placeholder="Paste the upstream API key (optional — you can add it later)"
                  value={apiKey}
                  disabled={disabled}
                  onChange={(e) => onApiKey(e.target.value)}
                />
                <p className="text-xs text-slate-500 mt-1.5">
                  Saved to the server vault when the project is created. Never shown again.
                </p>
              </div>
            )}

            {opt.id === 'access_token' && (
              <div className="mt-3 space-y-2" onClick={(e) => e.stopPropagation()}>
                <div>
                  <label className="label" htmlFor={loginInputId}>Login URI</label>
                  <input
                    id={loginInputId}
                    className="input mono"
                    placeholder="https://api.example.com/login"
                    value={loginUri}
                    disabled
                    onChange={(e) => onLoginUri(e.target.value)}
                  />
                </div>
                <button type="button" className="btn-secondary btn-sm" disabled title="Access-token login is disabled for the demo">
                  <ExternalLink size={14} /> Launch browser login
                </button>
                <p className="text-xs text-slate-500">
                  The browser login hands back an access token the connector uses instead of a key.
                </p>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
