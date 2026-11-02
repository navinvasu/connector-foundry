// DP-05: PII + secret redaction before anything lands in logs, telemetry,
// audit rows, eval details, or an invoke result.
//
// Two layers, applied everywhere through this one module:
//   1. Key-based — a value under a sensitive key (`password`, `api_key`,
//      `email`, `ssn`, `card_number`, …) is replaced wholesale, whatever
//      its format.
//   2. Value-pattern — strings are scanned for shapes that are sensitive
//      wherever they appear: email addresses, Bearer/Basic credentials,
//      JWTs, provider API-key shapes (AWS, GitHub, Stripe, OpenAI, Slack,
//      Google), sensitive URL query params, SSNs, Luhn-valid card numbers,
//      and US phone numbers.
//
// Deliberately conservative on look-alikes: card candidates must pass the
// Luhn checksum (order ids and totals survive), phone matching requires
// separators/parens (dates and plain digit runs survive), and free-text
// names/addresses are NOT pattern-redacted (no reliable shape — they are
// covered only when they sit under a PII key). Marker is always `REDACTED`,
// matching the prototype hook this module replaces.

export const REDACTED = 'REDACTED';

// ─── key-based ─────────────────────────────────────────────────────────────

const SECRET_KEY = /api[_-]?key|(^|[_-])key([_-]|$)|access[_-]?token|refresh[_-]?token|token|secret|pass(word|wd)?|authorization|cookie|credential|private[_-]?key|session[_-]?id|signature/i;
const PII_KEY = /e[-_]?mail|phone|mobile|ssn|social[_-]?security|tax[_-]?id|passport|driver[_-]?licen[cs]e|credit[_-]?card|card[_-]?num|cvv|cvc|iban|bank[_-]?account|account[_-]?number|routing[_-]?number|date[_-]?of[_-]?birth|(^|[_-])dob([_-]|$)|birthdate/i;

/** True when any value stored under this key must be redacted wholesale. */
export function isSensitiveKey(key: string): boolean {
  return SECRET_KEY.test(key) || PII_KEY.test(key);
}

// ─── value-pattern ─────────────────────────────────────────────────────────

function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (double) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    double = !double;
  }
  return digits.length >= 13 && sum % 10 === 0;
}

const KEY_SHAPES = /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b|\bgh[pousr]_[A-Za-z0-9]{20,}\b|\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{8,}\b|\bwhsec_[A-Za-z0-9]{8,}\b|\bsk-[A-Za-z0-9_-]{16,}\b|\bxox[baprs]-[A-Za-z0-9-]{8,}\b|\bAIza[0-9A-Za-z_-]{25,}\b|\bcf_live_[A-Za-z0-9_-]{8,}\b/g;

/** Redact sensitive shapes inside a single string. */
export function redactString(input: string): string {
  let s = input;
  // Sensitive URL query params first (their values may be any shape).
  s = s.replace(/([?&])([^=&#\s]+)=([^&\s#]*)/g, (m, sep: string, name: string, value: string) => {
    if (!value) return m;
    let decoded = name;
    try { decoded = decodeURIComponent(name); } catch { /* keep the raw name */ }
    return isSensitiveKey(decoded) ? `${sep}${name}=${REDACTED}` : m;
  });
  // Authorization schemes: "Bearer <token>", "Basic <base64>".
  s = s.replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi, `$1 ${REDACTED}`);
  // JWTs (three base64url segments, header starts with eyJ).
  s = s.replace(/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g, REDACTED);
  // Provider API-key shapes.
  s = s.replace(KEY_SHAPES, REDACTED);
  // Email addresses.
  s = s.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, REDACTED);
  // US Social Security numbers (ddd-dd-dddd).
  s = s.replace(/\b\d{3}-\d{2}-\d{4}\b/g, REDACTED);
  // Card numbers: digit runs (optional space/dash grouping) that pass Luhn.
  s = s.replace(/\b(?:\d[ -]?){12,18}\d\b/g, (m) => {
    const digits = m.replace(/\D/g, '');
    return digits.length <= 19 && luhnValid(digits) ? REDACTED : m;
  });
  // US phone numbers with separators/parens (plain digit runs are IDs, kept).
  s = s.replace(/(?:\+?1[-.\s]?)?(?:\(\d{3}\)|\d{3})[-.\s]\d{3}[-.\s]\d{4}\b/g, REDACTED);
  return s;
}

// ─── deep ──────────────────────────────────────────────────────────────────

const MAX_DEPTH = 6;
const MAX_ARRAY = 50;
const MAX_STRING = 2000;

/**
 * Deep-redact a value for logging/storage: sensitive keys wholesale,
 * pattern-scan every string, cap depth/array/string size exactly like the
 * prototype runtime hook did. Scalars pass through untouched; Dates are
 * left as-is (they serialize to ISO strings with no PII shape).
 */
export function redactValue(v: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return '[truncated]';
  if (Array.isArray(v)) return v.slice(0, MAX_ARRAY).map((x) => redactValue(x, depth + 1));
  if (v && typeof v === 'object') {
    if (v instanceof Date) return v;
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) {
      out[k] = isSensitiveKey(k) ? REDACTED : redactValue(val, depth + 1);
    }
    return out;
  }
  if (typeof v === 'string') {
    const r = redactString(v);
    return r.length > MAX_STRING ? r.slice(0, MAX_STRING) + '…[truncated]' : r;
  }
  return v;
}
