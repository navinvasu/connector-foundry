import { describe, it, expect } from 'vitest';
import type { GatewayKey } from '../../data/api';
import {
  gatewayKeyStatus, gatewayKeyExpiryLabel, canManageKeys, expiryIsoFor,
} from './gatewayKeys';

const now = new Date('2026-10-04T12:00:00.000Z');

function key(over: Partial<GatewayKey> = {}): GatewayKey {
  return {
    id: 'k1', project_id: 'p1', label: 'ci', prefix: 'cf_live_abcd1234',
    status: 'active', created_by: 'u1', created_at: '2026-10-01T00:00:00.000Z',
    expires_at: null, revoked_at: null, last_used_at: null, ...over,
  };
}

describe('gatewayKeyStatus', () => {
  it('reads active, expired, and revoked distinctly', () => {
    expect(gatewayKeyStatus(key(), now).label).toBe('Active');
    expect(gatewayKeyStatus(key({ expires_at: '2026-10-04T11:00:00.000Z' }), now).label).toBe('Expired');
    expect(gatewayKeyStatus(key({ status: 'revoked' }), now).label).toBe('Revoked');
  });
});

describe('gatewayKeyExpiryLabel', () => {
  it('covers never / future / past', () => {
    expect(gatewayKeyExpiryLabel(key(), now)).toBe('Never');
    expect(gatewayKeyExpiryLabel(key({ expires_at: '2027-10-04T12:00:00.000Z' }), now)).toContain('Expires');
    expect(gatewayKeyExpiryLabel(key({ expires_at: '2026-10-01T12:00:00.000Z' }), now)).toContain('Expired');
  });
});

describe('canManageKeys / expiryIsoFor', () => {
  it('owners and editors manage; viewers do not', () => {
    expect(canManageKeys('owner')).toBe(true);
    expect(canManageKeys('editor')).toBe(true);
    expect(canManageKeys('viewer')).toBe(false);
    expect(canManageKeys(null)).toBe(false);
  });

  it('maps expiry options to future ISO dates', () => {
    expect(expiryIsoFor('never', now)).toBeUndefined();
    expect(expiryIsoFor('30d', now)).toBe('2026-11-03T12:00:00.000Z');
    expect(expiryIsoFor('1y', now)).toBe('2027-10-04T12:00:00.000Z');
  });
});
