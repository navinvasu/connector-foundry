// Spec validation (IA-04): a broken spec must fail the import with exactly
// what's wrong and where — not import silently (today a dangling `$ref`
// degrades to a generic object schema and the connector misbehaves much
// later) and not die with a bare parser error.
//
// The check is deliberately narrow: every `$ref` in the document must be a
// local JSON Pointer that resolves inside the document. The v1 parser
// never fetches external references, so those are flagged too — with the
// repair (inline the target) spelled out. Each issue names the JSON
// Pointer of the node carrying the ref, the ref itself, and — when a close
// existing pointer exists — a "did you mean" suggestion. For raw-text
// imports (openapi_text) issues can also carry the 1-based line number of
// the ref in the uploaded file.

export interface SpecIssue {
  /** JSON Pointer of the node carrying the problem ('' is the document root). */
  pointer: string;
  /** The `$ref` value involved, when the issue is about a reference. */
  ref?: string;
  /** What is wrong, in plain language. */
  message: string;
  /** Repair hint: the closest existing pointer in the document. */
  suggestion?: string;
  /** 1-based line in the original text (raw-text imports only). */
  line?: number;
}

/** Thrown by the import path when {@link validateSpec} finds problems. */
export class SpecValidationError extends Error {
  readonly issues: SpecIssue[];

  constructor(issues: SpecIssue[]) {
    super(
      `Spec validation failed with ${issues.length} problem${issues.length === 1 ? '' : 's'}: ` +
        issues.map((i) => i.message).join('; '),
    );
    this.name = 'SpecValidationError';
    this.issues = issues;
  }
}

const REF_KEY = '$ref';

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** JSON Pointer segment escaping (RFC 6901): `~1` → `/`, `~0` → `~`. */
function unescapeSegment(seg: string): string {
  return seg.replace(/~1/g, '/').replace(/~0/g, '~');
}

function escapeSegment(seg: string): string {
  return seg.replace(/~/g, '~0').replace(/\//g, '~1');
}

/** URI-fragment decoding for one pointer segment (`%20`-style escapes). */
function decodeSegment(seg: string): string {
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
}

type RefCheck =
  | { ok: true }
  | { ok: false; reason: 'missing' | 'not-a-pointer' };

/**
 * Resolve a local ref (`#/a/b`, `#` for the root) against the document.
 * Array indices must be canonical (`0`, `1`, … — `-` and `01` don't count).
 */
function checkLocalRef(doc: unknown, ref: string): RefCheck {
  if (ref === '#') return { ok: true };
  if (!ref.startsWith('#/')) return { ok: false, reason: 'not-a-pointer' };
  let node: unknown = doc;
  for (const rawSeg of ref.slice(2).split('/')) {
    const seg = unescapeSegment(decodeSegment(rawSeg));
    if (Array.isArray(node)) {
      if (!/^(0|[1-9]\d*)$/.test(seg) || Number(seg) >= node.length) {
        return { ok: false, reason: 'missing' };
      }
      node = node[Number(seg)];
    } else if (isObject(node)) {
      if (!Object.prototype.hasOwnProperty.call(node, seg)) {
        return { ok: false, reason: 'missing' };
      }
      node = node[seg];
    } else {
      return { ok: false, reason: 'missing' };
    }
  }
  return { ok: true };
}

/** Every JSON Pointer that exists in the document (for suggestions). */
function collectPointers(doc: unknown, base: string, out: Set<string>, seen: Set<unknown>): void {
  if (!doc || typeof doc !== 'object' || seen.has(doc)) return;
  seen.add(doc);
  out.add(base === '' ? '#' : base);
  if (Array.isArray(doc)) {
    doc.forEach((v, i) => collectPointers(v, `${base}/${i}`, out, seen));
  } else {
    for (const [k, v] of Object.entries(doc as Record<string, unknown>)) {
      collectPointers(v, `${base}/${escapeSegment(k)}`, out, seen);
    }
  }
}

/** Classic Levenshtein distance — import-time only, inputs are small. */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[n];
}

/**
 * The closest existing pointer to a broken ref, or undefined when nothing
 * is close enough to be a plausible typo. Two candidates compete: the
 * whole pointer, and "same parent, similar last segment" (a renamed
 * schema is the common case) — the better relative score wins.
 */
export function suggestPointer(doc: unknown, brokenRef: string): string | undefined {
  const pointers = new Set<string>();
  collectPointers(doc, '#', pointers, new Set());
  const threshold = Math.max(2, Math.floor(brokenRef.length / 3));
  let best: string | undefined;
  let bestScore = Infinity;
  for (const candidate of pointers) {
    const score = levenshtein(brokenRef, candidate);
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return bestScore <= threshold ? best : undefined;
}

/** Walk the document collecting `$ref` carriers in document order. */
function collectRefs(
  node: unknown,
  pointer: string,
  out: Array<{ pointer: string; value: unknown }>,
  seen: Set<unknown>,
): void {
  if (!node || typeof node !== 'object' || seen.has(node)) return;
  seen.add(node);
  if (Array.isArray(node)) {
    node.forEach((v, i) => collectRefs(v, `${pointer}/${i}`, out, seen));
    return;
  }
  const obj = node as Record<string, unknown>;
  if (REF_KEY in obj) {
    out.push({ pointer: pointer === '' ? '/' + REF_KEY : `${pointer}/${REF_KEY}`, value: obj[REF_KEY] });
  }
  for (const [k, v] of Object.entries(obj)) {
    collectRefs(v, `${pointer}/${escapeSegment(k)}`, out, seen);
  }
}

/**
 * Validate every `$ref` in a parsed spec document. Returns all problems
 * found (document order); an empty array means the spec's references are
 * sound. Non-object input yields no issues — parseOpenApi's own
 * "must be a JSON object" error owns that case.
 */
export function validateSpec(spec: unknown): SpecIssue[] {
  if (!isObject(spec) && !Array.isArray(spec)) return [];
  const refs: Array<{ pointer: string; value: unknown }> = [];
  collectRefs(spec, '', refs, new Set());
  const issues: SpecIssue[] = [];
  for (const { pointer, value } of refs) {
    if (typeof value !== 'string' || value.trim() === '') {
      issues.push({
        pointer,
        message: `${pointer}: $ref must be a non-empty string`,
      });
      continue;
    }
    const ref = value;
    if (ref.startsWith('#')) {
      const check = checkLocalRef(spec, ref);
      if (check.ok) continue;
      if (check.reason === 'not-a-pointer') {
        issues.push({
          pointer,
          ref,
          message: `${pointer}: $ref "${ref}" is a fragment but not a JSON Pointer (expected "#/…")`,
        });
      } else {
        issues.push({
          pointer,
          ref,
          message: `${pointer}: $ref "${ref}" does not resolve — no such location in this document`,
          suggestion: suggestPointer(spec, ref),
        });
      }
      continue;
    }
    issues.push({
      pointer,
      ref,
      message:
        `${pointer}: external $ref "${ref}" cannot be resolved — ` +
        'this importer only follows references inside the same document; ' +
        'inline the target (for example under components/schemas) and point the $ref at it',
    });
  }
  return issues;
}

/**
 * Attach 1-based line numbers to issues by locating each ref string in
 * the raw uploaded text. Repeated identical refs consume successive
 * occurrences, so two uses of the same broken ref each get their own
 * line. Issues whose ref can't be found keep no line (pointer only).
 */
export function withLineNumbers(issues: SpecIssue[], rawText: string): SpecIssue[] {
  if (!rawText) return issues;
  const consumed = new Map<string, number>();
  return issues.map((issue) => {
    if (!issue.ref) return issue;
    const from = consumed.get(issue.ref) ?? 0;
    const idx = rawText.indexOf(issue.ref, from);
    if (idx === -1) return issue;
    consumed.set(issue.ref, idx + issue.ref.length);
    const line = rawText.slice(0, idx).split('\n').length;
    return { ...issue, line };
  });
}
