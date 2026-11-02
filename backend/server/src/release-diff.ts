// Release changelog (1.9): what changed for agents between two releases —
// tools added or removed, and per tool the text agents read and the access
// class. Pure over frozen snapshots, so the answer never drifts.

import { accessClassOf, agentDescription } from './tool-text.js';

export interface ToolChange {
  tool: string;
  change: 'added' | 'removed' | 'changed';
  fields?: Array<{ field: string; before: unknown; after: unknown }>;
}

type Snapshot = Record<string, any>;

function paramDescriptions(s: Snapshot): Record<string, string> {
  const props = (s?.input_schema?.properties ?? {}) as Record<string, { description?: string }>;
  return Object.fromEntries(Object.entries(props).map(([k, v]) => [k, v?.description ?? '']));
}

export function diffSnapshots(before: Snapshot[], after: Snapshot[]): ToolChange[] {
  const prev = new Map(before.map((s) => [String(s.name), s]));
  const next = new Map(after.map((s) => [String(s.name), s]));
  const out: ToolChange[] = [];
  for (const [name, s] of next) {
    const p = prev.get(name);
    if (!p) { out.push({ tool: name, change: 'added' }); continue; }
    const fields: NonNullable<ToolChange['fields']> = [];
    const cmp = (field: string, a: unknown, b: unknown) => {
      if (JSON.stringify(a ?? null) !== JSON.stringify(b ?? null)) fields.push({ field, before: a ?? null, after: b ?? null });
    };
    cmp('description', agentDescription(p), agentDescription(s));
    cmp('access_class', accessClassOf(p), accessClassOf(s));
    const pp = paramDescriptions(p);
    const sp = paramDescriptions(s);
    for (const k of new Set([...Object.keys(pp), ...Object.keys(sp)])) cmp(`param:${k}`, pp[k], sp[k]);
    if (fields.length > 0) out.push({ tool: name, change: 'changed', fields });
  }
  for (const name of prev.keys()) if (!next.has(name)) out.push({ tool: name, change: 'removed' });
  return out.sort((a, b) => a.tool.localeCompare(b.tool));
}
