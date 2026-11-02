import type { ReactNode } from 'react';
import { RefreshCw } from 'lucide-react';
import { cn } from '../lib/utils';

// ─── Badge ───────────────────────────────────────────────────────────────────

type BadgeTone = 'green' | 'red' | 'amber' | 'blue' | 'gray' | 'purple';

const toneClass: Record<BadgeTone, string> = {
  green: 'badge-green',
  red: 'badge-red',
  amber: 'badge-amber',
  blue: 'badge-blue',
  gray: 'badge-gray',
  purple: 'badge-purple',
};

export function Badge({ tone = 'gray', children, className }: { tone?: BadgeTone; children: ReactNode; className?: string }) {
  return <span className={cn(toneClass[tone], className)}>{children}</span>;
}

// ─── HTTP method chip ────────────────────────────────────────────────────────

const methodTone: Record<string, BadgeTone> = {
  GET: 'blue',
  POST: 'green',
  PUT: 'amber',
  PATCH: 'purple',
  DELETE: 'red',
};

export function MethodBadge({ method }: { method: string }) {
  return <Badge tone={methodTone[method] ?? 'gray'} className="mono font-semibold">{method}</Badge>;
}

// ─── Effect chip ─────────────────────────────────────────────────────────────

const effectTone: Record<string, BadgeTone> = {
  READ: 'blue',
  WRITE: 'amber',
  DESTRUCTIVE: 'red',
  UNKNOWN: 'gray',
};

export function EffectBadge({ effect }: { effect: string }) {
  return <Badge tone={effectTone[effect] ?? 'gray'}>{effect}</Badge>;
}

// ─── Stat card (generic) ─────────────────────────────────────────────────────

export function StatCard({
  label, value, sub, icon, onClick, selected,
}: {
  label: string;
  value: string;
  sub?: string;
  icon?: ReactNode;
  onClick?: () => void;
  selected?: boolean;
}) {
  const inner = (
    <>
      <div className="flex items-center justify-between">
        <div className="text-sm text-slate-400">{label}</div>
        {icon}
      </div>
      <div className="font-display text-3xl font-semibold text-white mt-1">{value}</div>
      {sub && <div className="text-xs text-slate-500 mt-1">{sub}</div>}
    </>
  );
  if (!onClick) return <div className="card-pad">{inner}</div>;
  return (
    <button
      onClick={onClick}
      className={cn(
        'card-pad text-left w-full transition-colors hover:border-white/25 cursor-pointer',
        selected && 'border-neon/60 ring-1 ring-neon/40',
      )}
    >
      {inner}
    </button>
  );
}

// ─── KPI card (command-center hero stat) ─────────────────────────────────────
// Mirrors the Dreamforce-style dashboard: colored tag pill, big display number,
// delta chip, and a neon accent underline.

type KpiAccent = 'orange' | 'green' | 'red' | 'amber' | 'pink';

const accentVar: Record<KpiAccent, string> = {
  orange: '#ffa02e',
  green: '#34d399',
  red: '#f87171',
  amber: '#fbbf24',
  pink: '#f472b6',
};

const tagClass: Record<KpiAccent, string> = {
  orange: 'bg-neon/15 text-neon border border-neon/30',
  green: 'bg-emerald-400/15 text-emerald-300 border border-emerald-400/30',
  red: 'bg-red-400/15 text-red-300 border border-red-400/30',
  amber: 'bg-amber-400/15 text-amber-300 border border-amber-400/30',
  pink: 'bg-pink-400/15 text-pink-300 border border-pink-400/30',
};

export function KpiCard({
  tag,
  accent = 'orange',
  label,
  value,
  delta,
  deltaUp,
  sub,
}: {
  tag: string;
  accent?: KpiAccent;
  label: string;
  value: string;
  delta?: string;
  deltaUp?: boolean;
  sub?: string;
}) {
  return (
    <div className="kpi-card" style={{ ['--kpi-accent' as string]: accentVar[accent] }}>
      <div className="flex items-center justify-between gap-2">
        <span className={cn('kpi-tag', tagClass[accent])}>{tag}</span>
        {delta && (
          <span className={cn('kpi-delta', deltaUp ? 'text-emerald-300' : 'text-red-300')}>
            {deltaUp ? '▲' : '▼'} {delta}
          </span>
        )}
      </div>
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      {sub && <div className="kpi-sub">{sub}</div>}
    </div>
  );
}

// ─── Ticker strip ────────────────────────────────────────────────────────────

export function Ticker({ items }: { items: string[] }) {
  const doubled = [...items, ...items];
  return (
    <div className="ticker-wrap">
      <div className="ticker-track">
        {doubled.map((item, i) => (
          <span key={i} className="ticker-item">
            <span className="ticker-dot" />
            {item}
          </span>
        ))}
      </div>
    </div>
  );
}

// ─── Progress bar ────────────────────────────────────────────────────────────

export function ProgressBar({ value, tone = 'brand' }: { value: number; tone?: 'brand' | 'green' | 'red' | 'amber' }) {
  const bar =
    tone === 'brand'
      ? 'bg-gradient-to-r from-neon-dim to-neon shadow-glow'
      : tone === 'green'
        ? 'bg-emerald-400'
        : tone === 'red'
          ? 'bg-red-400'
          : 'bg-amber-400';
  return (
    <div className="w-full bg-white/10 rounded-full h-2">
      <div className={cn('h-2 rounded-full transition-all', bar)} style={{ width: `${Math.min(100, Math.max(0, value))}%` }} />
    </div>
  );
}

// ─── Section header ──────────────────────────────────────────────────────────

export function SectionHeader({
  title,
  sub,
  index,
  hint,
  action,
}: {
  title: string;
  sub?: string;
  index?: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between mb-4 gap-4">
      <div className="flex items-center gap-3 flex-wrap">
        {index && <span className="section-index">{index}</span>}
        <h2 className="section-title">{title}</h2>
        {hint && <span className="section-hint">{hint}</span>}
      </div>
      <div className="flex items-center gap-3">
        {sub && !hint && <p className="text-sm text-slate-400">{sub}</p>}
        {action}
      </div>
    </div>
  );
}

// ─── Empty state ─────────────────────────────────────────────────────────────
// FE-05: every no-data state explains itself and names the next action —
// the `action` slot is where that next step lives (a button or link).

export function EmptyState({ title, sub, action }: { title: string; sub?: string; action?: ReactNode }) {
  return (
    <div className="card-pad text-center py-10">
      <div className="text-sm font-medium text-slate-200">{title}</div>
      {sub && <div className="text-sm text-slate-500 mt-1">{sub}</div>}
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}

// ─── Loading state (FE-05) ───────────────────────────────────────────────────
// Shown instead of the empty state while a screen's first fetch is in
// flight (see resolveListState), so "nothing here yet" never flashes.

export function LoadingState({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="card-pad text-center py-10" role="status">
      <div className="text-sm text-slate-400 animate-pulse">{label}</div>
    </div>
  );
}

// ─── Error state (FE-05) ─────────────────────────────────────────────────────
// A failed load explains what happened and offers the retry as its next
// action. Used when the screen holds no data to fall back on; failures
// over held data stay inline banners at the call site instead.

export function ErrorState({
  message,
  hint,
  onRetry,
}: {
  message: string;
  hint?: string;
  onRetry?: () => void;
}) {
  return (
    <div className="card p-6 text-center space-y-3" role="alert">
      <div className="text-sm text-red-300">{message}</div>
      {hint && <p className="text-xs text-slate-500">{hint}</p>}
      {onRetry && (
        <button onClick={onRetry} className="btn-secondary btn-sm mx-auto">
          <RefreshCw size={14} /> Retry
        </button>
      )}
    </div>
  );
}

// ─── Key/value row ───────────────────────────────────────────────────────────

export function KvRow({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2 border-b border-white/10 last:border-0">
      <dt className="text-sm text-slate-400 shrink-0">{k}</dt>
      <dd className="text-sm text-slate-100 text-right">{children}</dd>
    </div>
  );
}
