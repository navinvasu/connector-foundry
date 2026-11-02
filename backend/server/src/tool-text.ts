// What an agent is told about a tool, built the same way for every surface
// (hosted MCP, OpenAI artifacts, the agent runner). The owner-edited
// "use when" / "don't use when" guidance is part of the description an
// agent reads, so improving it changes agent behavior (HK-09 → EV-08).
// Access classes (HK-01 A1, D-85) and MCP annotations derive from the
// tool's effect classes.

export type AccessClass = 'read' | 'write' | 'sensitive_write';

interface ToolText {
  name?: unknown;
  description?: unknown;
  eligible_use?: unknown;
  ineligible_use?: unknown;
  effect_classes?: unknown;
  confirmation_required?: unknown;
  idempotent?: unknown;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

export function agentDescription(t: ToolText): string {
  const parts = [str(t.description)];
  const use = str(t.eligible_use);
  const avoid = str(t.ineligible_use);
  if (use) parts.push(`Use when: ${use}`);
  if (avoid) parts.push(`Do not use when: ${avoid}`);
  return parts.filter(Boolean).join('\n');
}

function effectClasses(t: ToolText): string[] {
  const raw = t.effect_classes;
  let list: unknown = raw;
  if (typeof raw === 'string') {
    try { list = JSON.parse(raw); } catch { list = []; }
  }
  return Array.isArray(list) ? list.filter((c): c is string => typeof c === 'string') : [];
}

/**
 * read → only read_only effects; sensitive_write → destructive, or the owner
 * required confirmation; anything else (incl. unclassified) → write.
 */
export function accessClassOf(t: ToolText): AccessClass {
  const classes = effectClasses(t);
  if (classes.includes('destructive') || t.confirmation_required === true) return 'sensitive_write';
  if (classes.length > 0 && classes.every((c) => c === 'read_only')) return 'read';
  return 'write';
}

/** "getOrderStatus" → "Get order status". */
export function toolTitle(name: string): string {
  const words = name.replace(/[_-]+/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').trim().toLowerCase();
  return words ? words[0]!.toUpperCase() + words.slice(1) : name;
}

/** MCP tool annotations (2025-03-26 spec) for a tool. */
export function mcpAnnotations(t: ToolText): Record<string, unknown> {
  const access = accessClassOf(t);
  return {
    title: toolTitle(str(t.name)),
    readOnlyHint: access === 'read',
    destructiveHint: access === 'sensitive_write',
    idempotentHint: access === 'read' || t.idempotent === true,
    openWorldHint: true,
  };
}
