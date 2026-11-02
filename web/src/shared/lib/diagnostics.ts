// Client-side diagnostics: a bounded in-memory log of what the user did
// and what the console asked the API — button clicks, API calls with
// response times and request ids, background queue transitions. Nothing
// here carries request/response bodies (keys and tokens must never sit in
// a downloadable log); the request id joins each entry to the server's own
// `request` log line. Open devtools for the live stream; download the JSON
// when filing a bug.

export interface DiagEntry {
  t: string;
  kind: 'click' | 'api' | 'queue' | 'note';
  label: string;
  detail?: Record<string, unknown>;
  duration_ms?: number;
  ok?: boolean;
}

const CAP = 300;
const entries: DiagEntry[] = [];

function emit(entry: DiagEntry): void {
  entries.push(entry);
  if (entries.length > CAP) entries.splice(0, entries.length - CAP);
  try {
    // eslint-disable-next-line no-console
    console.info('[diag]', entry.kind, entry.label, entry.detail ?? '', entry.duration_ms ?? '');
  } catch { /* logging must never break the app */ }
}

export function logAction(
  kind: DiagEntry['kind'],
  label: string,
  detail?: Record<string, unknown>,
  duration_ms?: number,
  ok?: boolean,
): void {
  emit({ t: new Date().toISOString(), kind, label, detail, duration_ms, ok });
}

export function getDiagnostics(): DiagEntry[] {
  return [...entries];
}

export function clearDiagnostics(): void {
  entries.length = 0;
}

function clickLabel(el: Element): string {
  const asHtml = el as HTMLElement;
  return (
    asHtml.getAttribute?.('data-diag') ||
    asHtml.getAttribute?.('aria-label') ||
    (asHtml.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 80) ||
    asHtml.id ||
    asHtml.getAttribute?.('name') ||
    el.tagName.toLowerCase()
  );
}

let installed = false;

/** Capture-phase click listener: every button/link/form click lands in the
 *  buffer with the route it happened on. Safe to call twice; no-ops
 *  without a DOM (tests, SSR). */
export function installClickLogging(): void {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  document.addEventListener('click', (e) => {
    const target = e.target as Element | null;
    const el = target?.closest?.('button, a, input, select, textarea, [role="button"]');
    if (!el) return;
    let path = '';
    try { path = window.location.pathname; } catch { /* ignore */ }
    logAction('click', clickLabel(el), { tag: el.tagName.toLowerCase(), path });
  }, true);
}

/** Download the buffered entries as JSON for a bug report. No-ops without a DOM. */
export function downloadDiagnostics(): void {
  if (typeof document === 'undefined' || typeof URL === 'undefined') return;
  let path = '';
  try { path = window.location.pathname; } catch { /* ignore */ }
  const payload = JSON.stringify(
    { exported_at: new Date().toISOString(), route: path, entries: getDiagnostics() },
    null,
    2,
  );
  const url = URL.createObjectURL(new Blob([payload], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `foundry-diagnostics-${Date.now()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 5000);
}
