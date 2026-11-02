// SE-10: invite minting stores only the token's SHA-256 hash. Supertest
// over the members router with a mocked DB — asserts no captured INSERT /
// UPDATE parameter ever equals the plaintext token returned to the inviter,
// and the stored value is exactly hashInviteToken(plaintext).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const txQueries: Array<[string, any[]]> = [];
vi.mock('../db.js', () => ({
  one: vi.fn(),
  q: vi.fn(async () => []),
  exec: vi.fn(async () => 1),
  withTx: vi.fn(async (fn: any) =>
    fn({ query: async (sql: string, params: any[]) => { txQueries.push([sql, params]); return { rows: [] }; } }),
  ),
  uid: () => 'uid-1',
}));

vi.mock('../auth.js', () => ({
  requireCustomerRole: () => (req: any, _res: any, next: any) => {
    req.customer = { customerId: req.params.id, customerStatus: 'active', role: 'owner' };
    next();
  },
  customerWritable: () => true,
}));

import { one } from '../db.js';
import { membersRouter } from './members.js';
import { hashInviteToken } from '../invites.js';

const oneMock = vi.mocked(one);

function app() {
  const a = express();
  a.use(express.json());
  a.use((req: any, _res, next) => { req.auth = { userId: 'u-owner', email: 'owner@acme.test' }; next(); });
  a.use('/v1/customers', membersRouter);
  a.use((err: any, _req: any, res: any, _next: any) => {
    res.status(err?.status ?? 500).json({ error: err?.message ?? 'error' });
  });
  return a;
}

const allTxParams = () => txQueries.flatMap(([, params]) => params ?? []);

beforeEach(() => {
  vi.clearAllMocks();
  txQueries.length = 0;
  oneMock.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM customers c JOIN plans')) {
      return { seat_cap: 10, seat_override: null, plan_seat_cap: 10, project_cap: 25 };
    }
    if (sql.includes('COUNT(*)::int')) return { n: 0 };
    return undefined; // no existing user, no existing membership
  });
});

describe('POST /v1/customers/:id/users/invite (SE-10 hash at rest)', () => {
  it('stores only the SHA-256 hash; the plaintext leaves solely in the 201 response', async () => {
    const res = await request(app())
      .post('/v1/customers/c1/users/invite')
      .send({ email: 'invitee@acme.test', role: 'editor' });
    expect(res.status).toBe(201);
    expect(res.body.invited).toBe(true);

    const token: string = res.body.invite_token;
    expect(token).toMatch(/^[0-9a-f]{48}$/); // 24 random bytes, hex

    const insert = txQueries.find(([sql]) => sql.includes('INSERT INTO customer_users'));
    expect(insert).toBeDefined();
    expect(insert![0]).toContain('invite_token_hash');
    expect(allTxParams()).toContain(hashInviteToken(token));
    expect(allTxParams()).not.toContain(token);
  });

  it('re-invite rotates the token and stores only the new hash', async () => {
    oneMock.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM customers c JOIN plans')) {
        return { seat_cap: 10, seat_override: null, plan_seat_cap: 10, project_cap: 25 };
      }
      if (sql.includes('COUNT(*)::int')) return { n: 1 };
      if (sql.includes('FROM users WHERE lower(email)')) return { id: 'u-inv', email: 'invitee@acme.test' };
      if (sql.includes('FROM customer_users WHERE customer_id')) {
        return { id: 'm1', status: 'invited', role: 'viewer' };
      }
      return undefined;
    });
    const res = await request(app())
      .post('/v1/customers/c1/users/invite')
      .send({ email: 'invitee@acme.test', role: 'editor' });
    expect(res.status).toBe(201);
    expect(res.body.reinvited).toBe(true);

    const update = txQueries.find(([sql]) => sql.includes('UPDATE customer_users SET status'));
    expect(update).toBeDefined();
    expect(update![0]).toContain('invite_token_hash = $1');
    expect(allTxParams()).toContain(hashInviteToken(res.body.invite_token));
    expect(allTxParams()).not.toContain(res.body.invite_token);
  });
});
