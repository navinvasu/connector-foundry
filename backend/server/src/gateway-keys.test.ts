// DP-07: gateway key primitives — secret shape, hash-only storage,
// header extraction, and authentication verdicts (mocked DB).
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./db.js', () => ({
  one: vi.fn(),
  exec: vi.fn(),
}));

import { one, exec } from './db.js';
import {
  generateGatewayKeySecret, gatewayKeyPrefix, hashGatewayKey, gatewayHashMatches,
  extractGatewayKey, authenticateGatewayKey, gatewayActor,
} from './gateway-keys.js';

const oneMock = vi.mocked(one);
const execMock = vi.mocked(exec);

const SECRET = generateGatewayKeySecret();

function keyRow(over: any = {}) {
  return {
    id: 'k1', project_id: 'p1', label: 'ci', key_prefix: gatewayKeyPrefix(SECRET),
    key_hash: hashGatewayKey(SECRET), status: 'active', expires_at: null,
    customer_status: 'active', ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  oneMock.mockResolvedValue(undefined);
  execMock.mockResolvedValue(1);
});

describe('secret shape', () => {
  it('mints cf_live_ secrets whose prefix never reveals the tail', () => {
    const s = generateGatewayKeySecret();
    expect(s.startsWith('cf_live_')).toBe(true);
    expect(s.length).toBeGreaterThan(30);
    expect(gatewayKeyPrefix(s)).toBe(s.slice(0, 16));
    expect(s.includes(gatewayKeyPrefix(s).slice(8))).toBe(true);
    // Two mints differ.
    expect(generateGatewayKeySecret()).not.toBe(s);
  });

  it('hashes deterministically and compares in constant time', () => {
    expect(hashGatewayKey(SECRET)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashGatewayKey(SECRET)).toBe(hashGatewayKey(SECRET));
    expect(gatewayHashMatches(hashGatewayKey(SECRET), SECRET)).toBe(true);
    expect(gatewayHashMatches(hashGatewayKey(SECRET), SECRET + 'x')).toBe(false);
    expect(gatewayHashMatches(null, SECRET)).toBe(false);
    // The stored hash never contains the secret.
    expect(hashGatewayKey(SECRET)).not.toContain(SECRET.slice(8));
  });
});

describe('extractGatewayKey', () => {
  it('reads the Bearer header', () => {
    expect(extractGatewayKey({ authorization: `Bearer ${SECRET}` })).toBe(SECRET);
  });

  it('reads X-API-Key', () => {
    expect(extractGatewayKey({ 'x-api-key': SECRET })).toBe(SECRET);
  });

  it('ignores human JWTs and missing headers', () => {
    expect(extractGatewayKey({ authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.x.y' })).toBeNull();
    expect(extractGatewayKey({})).toBeNull();
    expect(extractGatewayKey({ 'x-api-key': 'not-a-gateway-key' })).toBeNull();
  });
});

describe('authenticateGatewayKey', () => {
  it('accepts an active, unexpired key', async () => {
    oneMock.mockResolvedValue(keyRow());
    const row = await authenticateGatewayKey(SECRET);
    expect(row?.id).toBe('k1');
    expect(gatewayActor(row!)).toBe(`api-key:${gatewayKeyPrefix(SECRET)}`);
    expect(gatewayActor(row!)).not.toContain(SECRET.slice(16));
  });

  it('rejects unknown, revoked, and expired keys identically (null)', async () => {
    oneMock.mockResolvedValue(undefined);
    expect(await authenticateGatewayKey(SECRET)).toBeNull();
    oneMock.mockResolvedValue(keyRow({ status: 'revoked' }));
    expect(await authenticateGatewayKey(SECRET)).toBeNull();
    oneMock.mockResolvedValue(keyRow({ expires_at: '2020-01-01T00:00:00.000Z' }));
    expect(await authenticateGatewayKey(SECRET)).toBeNull();
  });

  it('rejects non-gateway values without a DB hit', async () => {
    expect(await authenticateGatewayKey('eyJhbGciOiJIUzI1NiJ9')).toBeNull();
    expect(oneMock).not.toHaveBeenCalled();
  });
});
