// Multi-term tool search: the filter box accepts one substring per line, so a
// pasted list ("GET /get\nGET /ip\n…") finds every listed tool. A tool
// matches when ANY term appears in its name or upstream (OR semantics); a
// single line behaves exactly like the old single-substring filter.

/** Split raw input into lowercase search terms: one per non-blank line. */
export function parseSearchTerms(query: string): string[] {
  return query
    .split(/\r?\n/)
    .map((line) => line.trim().toLowerCase())
    .filter((line) => line.length > 0);
}

/** True when any term is a substring of the tool's name or upstream. */
export function matchesSearch(
  tool: { name: string; upstream: string },
  terms: string[],
): boolean {
  if (terms.length === 0) return false;
  const name = tool.name.toLowerCase();
  const upstream = tool.upstream.toLowerCase();
  return terms.some((raw) => {
    const t = raw.trim().toLowerCase();
    return t.length > 0 && (name.includes(t) || upstream.includes(t));
  });
}
