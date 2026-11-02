// DP-07 console helpers: pure display/permission logic for the gateway
// API key panel, kept separate from the component so it is unit-testable
// without a DOM (the web suite has no component renderer).

import type { GatewayKey } from '../../data/api';

export type KeyTone = 'green' | 'red' | 'amber' | 'gray';

/** Effective status: an unrevoked key past its expiry reads Expired. */
export function gatewayKeyStatus(key: GatewayKey, now: Date = new Date()): { label: string; tone: KeyTone } {
  if (key.status === 'revoked') return { label: 'Revoked', tone: 'red' };
  if (key.expires_at && new Date(key.expires_at) <= now) return { label: 'Expired', tone: 'amber' };
  return { label: 'Active', tone: 'green' };
}

/** Human expiry line: "Never", "Expired Oct 4, 2026", or "Expires Oct 4, 2027". */
export function gatewayKeyExpiryLabel(key: GatewayKey, now: Date = new Date()): string {
  if (!key.expires_at) return 'Never';
  const d = new Date(key.expires_at).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  });
  return new Date(key.expires_at) <= now ? `Expired ${d}` : `Expires ${d}`;
}

/** Owner/editor manage keys; viewers are read-only (FE-09: the API is the gate). */
export function canManageKeys(callerRole: string | null): boolean {
  return callerRole === 'owner' || callerRole === 'editor';
}

/** Optional expiry choices for the mint form, as offsets from now. */
export const EXPIRY_OPTIONS = [
  { id: 'never', label: 'Never expires' },
  { id: '30d', label: '30 days' },
  { id: '90d', label: '90 days' },
  { id: '1y', label: '1 year' },
] as const;

export function expiryIsoFor(optionId: string, now: Date = new Date()): string | undefined {
  const days = optionId === '30d' ? 30 : optionId === '90d' ? 90 : optionId === '1y' ? 365 : 0;
  if (!days) return undefined;
  return new Date(now.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
}
