import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

/**
 * Right-side detail drawer. In-screen actions (history entries, "show all"
 * overflow chips) open details here instead of replacing the whole screen,
 * so the main content never reloads under the user. Dismisses via the
 * close button, the backdrop, or Escape.
 *
 * Portaled to document.body: card surfaces use backdrop-filter, which
 * would otherwise capture `position: fixed` and pin the drawer inside
 * the card instead of the viewport.
 */
export default function SidePanel({
  title,
  sub,
  onClose,
  children,
}: {
  title: string;
  sub?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label={title}>
      <div className="absolute inset-0 bg-black/60" onClick={onClose} aria-hidden="true" />
      <aside className="absolute right-0 top-0 h-full w-full max-w-xl bg-ink-950 border-l border-white/10 shadow-2xl flex flex-col">
        <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-white/10">
          <div className="min-w-0">
            <h2 className="font-display text-lg font-semibold text-white truncate">{title}</h2>
            {sub && <p className="text-xs text-slate-400 mt-0.5">{sub}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close panel"
            className="rounded-md border border-white/10 p-1.5 text-slate-400 hover:text-slate-100 hover:border-white/25 shrink-0"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">{children}</div>
      </aside>
    </div>,
    document.body,
  );
}
