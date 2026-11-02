// Call attribution (D-89): which channel and client made a data-plane call,
// and whether a person's prompt, an agent's own follow-up, or an automated
// job triggered it.
//
// "Declared" values come from callers that know: the console playground,
// the agent runner, or any MCP client that sends `_meta` on tools/call.
// Everything else is "inferred" from the session: the first call, or one
// after a pause, starts a new user turn; calls in quick succession are the
// agent following up on its own. A gateway-key call outside any agent
// session is automated. Third-party agents (Claude, ChatGPT, Muse) never
// send the user's prompt, so prompt text exists only when declared.

import { redactString } from './redact.js';

export type Channel = 'mcp' | 'openai_actions' | 'rest' | 'playground';
export type Trigger = 'user_prompt' | 'agent_followup' | 'automated' | 'unknown';
export type TriggerSource = 'declared' | 'inferred';

export interface Attribution {
  channel: Channel;
  client?: string | null;
  trigger: Trigger;
  trigger_source: TriggerSource;
  session_id?: string | null;
  turn_id?: string | null;
  /** Raw prompt as declared; redacted + truncated before it is stored. */
  prompt?: string | null;
}

/** A pause longer than this between calls in one session starts a new user turn. */
export const TURN_GAP_MS = 20_000;

export const PROMPT_MAX_CHARS = 500;

/** `_meta` keys an MCP client may send on tools/call to declare attribution. */
export const META_KEYS = {
  turnId: 'connectorfoundry.com/turn_id',
  trigger: 'connectorfoundry.com/trigger',
  prompt: 'connectorfoundry.com/prompt',
} as const;

const TRIGGERS: readonly Trigger[] = ['user_prompt', 'agent_followup', 'automated', 'unknown'];

export function asTrigger(v: unknown): Trigger | null {
  return typeof v === 'string' && (TRIGGERS as readonly string[]).includes(v) ? (v as Trigger) : null;
}

/** First call in a session, or one after a pause → user turn; else agent follow-up. */
export function inferTrigger(lastCallAt: Date | null, now: Date = new Date()): Trigger {
  if (!lastCallAt) return 'user_prompt';
  return now.getTime() - lastCallAt.getTime() > TURN_GAP_MS ? 'user_prompt' : 'agent_followup';
}

/** Prompt text safe to store: PII/secret patterns redacted, length capped. */
export function storablePrompt(prompt: string | null | undefined): string | null {
  if (!prompt || !prompt.trim()) return null;
  const clean = redactString(prompt.trim());
  return clean.length > PROMPT_MAX_CHARS ? `${clean.slice(0, PROMPT_MAX_CHARS - 1)}…` : clean;
}

function str(v: unknown, max = 200): string | null {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;
}

/** Declared attribution from a tools/call `_meta` object (null when nothing usable). */
export function declaredFromMeta(meta: unknown): { trigger: Trigger | null; turn_id: string | null; prompt: string | null } {
  const m = meta && typeof meta === 'object' && !Array.isArray(meta) ? (meta as Record<string, unknown>) : {};
  return {
    trigger: asTrigger(m[META_KEYS.trigger]),
    turn_id: str(m[META_KEYS.turnId], 120),
    prompt: str(m[META_KEYS.prompt], 4000),
  };
}
