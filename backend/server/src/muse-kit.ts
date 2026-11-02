// Meta Muse submission kit (HK-08, D-85): Muse has no manifest spec or
// publish API — intake is a manual, review-gated form (RL-02) whose
// preferred "Existing MCP" route points at our hosted MCP endpoint. The
// kit is therefore everything the customer needs to fill that form from a
// frozen release: the endpoint, per-tool Read/Write/Sensitive-write
// access classes (guidelines §6.2), auth requirements, review gate result,
// and a form checklist with prefilled values.
//
// The gate is honest, not a certification: money movement is a documented
// keyword heuristic over tool names/descriptions (customer confirms),
// and any destructive or unconfirmed write blocks the kit with a reason.

export type MuseAccessClass = 'read' | 'write' | 'sensitive_write';

export interface MuseKitTool {
  name: string;
  description: string;
  access_class: MuseAccessClass;
  confirmation: 'always' | 'never';
  effects: string[];
}

export interface MuseGateReason {
  tool: string;
  reason: 'money_movement' | 'destructive_tool' | 'unconfirmed_write';
  message: string;
}

/** Name/description keywords that suggest money movement (RL-02: transfers,
 *  trade orders and other financial money-movement tools are not approved).
 *  Heuristic — the customer confirms any hit before submitting. */
export const MONEY_MOVEMENT_KEYWORDS = [
  'transfer', 'payment', 'payout', 'withdraw', 'deposit', 'trade',
  'checkout', 'charge', 'refund', 'send_money', 'sendmoney', 'remittance',
];

/** Guidelines §6.2 tool review classes from the frozen effect classes. */
export function accessClassFor(snapshot: Record<string, any>): MuseAccessClass {
  const effects = Array.isArray(snapshot.effect_classes)
    ? snapshot.effect_classes.map(String)
    : [];
  if (effects.includes('destructive')) return 'sensitive_write';
  if (effects.includes('mutating')) return 'write';
  return 'read';
}

export function looksLikeMoneyMovement(name: string, description: string): boolean {
  const hay = `${name} ${description}`.toLowerCase();
  return MONEY_MOVEMENT_KEYWORDS.some((k) => hay.includes(k));
}

export interface MuseKitInput {
  releaseId: string;
  version: string;
  connectorName: string;
  description: string;
  mcpEndpoint: string;
  snapshots: Array<Record<string, any>>;
}

export interface MuseKit {
  connector: { name: string; version: string; release_id: string; description: string };
  connection: { type: 'existing_mcp'; mcp_endpoint: string; note: string };
  tools: MuseKitTool[];
  auth: { modes: string[]; scopes: string[] };
  review_gate: { eligible: boolean; reasons: MuseGateReason[] };
  form_checklist: Array<{ field: string; value: string }>;
}

export function buildMuseKit(input: MuseKitInput): MuseKit {
  const tools: MuseKitTool[] = input.snapshots.map((s) => ({
    name: String(s.name ?? 'unnamed'),
    description: String(s.description ?? ''),
    access_class: accessClassFor(s),
    confirmation: s.confirmation_required ? 'always' : 'never',
    effects: Array.isArray(s.effect_classes) ? s.effect_classes.map(String) : [],
  }));

  const modes = new Set<string>();
  const scopes = new Set<string>();
  for (const s of input.snapshots) {
    // Frozen compiler snapshots carry credential_mode/required_scopes.
    if (typeof s.credential_mode === 'string' && s.credential_mode !== 'none') modes.add(s.credential_mode);
    const list = s.required_scopes;
    if (Array.isArray(list)) for (const sc of list) if (typeof sc === 'string') scopes.add(sc);
  }

  const reasons: MuseGateReason[] = [];
  for (const t of tools) {
    const snap = input.snapshots.find((s) => String(s.name) === t.name);
    const desc = String(snap?.description ?? '');
    if (looksLikeMoneyMovement(t.name, desc)) {
      reasons.push({ tool: t.name, reason: 'money_movement',
        message: `${t.name} looks like money movement — Meta does not approve financial money-movement tools. Confirm, remove it from the release, or do not submit.` });
      continue;
    }
    if (t.effects.includes('destructive')) {
      reasons.push({ tool: t.name, reason: 'destructive_tool',
        message: `${t.name} is destructive — get explicit customer approval and confirm its confirmation rule before submitting.` });
    } else if (t.access_class !== 'read' && t.confirmation !== 'always') {
      reasons.push({ tool: t.name, reason: 'unconfirmed_write',
        message: `${t.name} writes without an always-confirm rule — require confirmation before submitting.` });
    }
  }

  return {
    connector: {
      name: input.connectorName, version: input.version,
      release_id: input.releaseId, description: input.description,
    },
    connection: {
      type: 'existing_mcp',
      mcp_endpoint: input.mcpEndpoint,
      note: 'Muse intake (muse.ai/platform) accepts an Existing MCP endpoint plus documentation — no Meta-specific packaging. Paste the endpoint and the capabilities below into the form.',
    },
    tools,
    auth: { modes: [...modes].sort(), scopes: [...scopes].sort() },
    review_gate: { eligible: reasons.length === 0, reasons },
    form_checklist: [
      { field: 'Overview → connector name', value: input.connectorName },
      { field: 'Overview → description', value: input.description },
      { field: 'Overview → example prompts', value: 'Write 2–3 prompts from the capabilities above (e.g. "Use <tool> to …").' },
      { field: 'Technical specs → connection type', value: `Existing MCP: ${input.mcpEndpoint}` },
      { field: 'Technical specs → auth', value: modes.size > 0 ? `API key (${[...modes].sort().join(', ')}) — reviewers need test credentials` : 'None (public endpoints) — note this on the form' },
      { field: 'Review → attestations', value: 'Confirm you are authorized to submit and accept the Connector Terms (muse.ai/platform/terms).' },
    ],
  };
}
