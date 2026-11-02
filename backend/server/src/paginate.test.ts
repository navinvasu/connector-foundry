// BE-08: keyset pagination helper tests.
import { describe, it, expect } from 'vitest';
import {
  parsePagination, encodeCursor, keysetClause, buildPage, DEFAULT_LIMIT, MAX_LIMIT,
} from './paginate.js';

describe('parsePagination', () => {
  it('defaults to limit 50 with no cursor', () => {
    const r = parsePagination({});
    expect(r).toEqual({ ok: true, limit: 50, cursor: null });
    expect(DEFAULT_LIMIT).toBe(50);
  });

  it('accepts an explicit limit', () => {
    expect(parsePagination({ limit: '10' })).toEqual({ ok: true, limit: 10, cursor: null });
  });

  it(`clamps the limit to MAX_LIMIT (${MAX_LIMIT})`, () => {
    const r = parsePagination({ limit: '9999' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.limit).toBe(MAX_LIMIT);
  });

  it('rejects non-positive and non-numeric limits', () => {
    for (const limit of ['0', '-3', 'abc', '1.5x']) {
      const r = parsePagination({ limit });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.fields.limit).toMatch(/positive integer/);
    }
  });

  it('round-trips an encoded cursor', () => {
    const cursor = encodeCursor(new Date('2026-09-28T12:00:00.000Z'), 'row-1');
    const r = parsePagination({ cursor });
    expect(r).toEqual({
      ok: true, limit: 50,
      cursor: { t: '2026-09-28T12:00:00.000Z', i: 'row-1' },
    });
  });

  it('treats an empty cursor as absent', () => {
    expect(parsePagination({ cursor: '' })).toEqual({ ok: true, limit: 50, cursor: null });
  });

  it('rejects malformed cursors', () => {
    const bad = [
      '!!!not-base64!!!',
      Buffer.from('[]').toString('base64url'),
      Buffer.from(JSON.stringify({ t: 123, i: 'x' })).toString('base64url'),
      Buffer.from(JSON.stringify({ t: '', i: '' })).toString('base64url'),
    ];
    for (const cursor of bad) {
      const r = parsePagination({ cursor });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.fields.cursor).toMatch(/invalid/);
    }
  });
});

describe('keysetClause', () => {
  it('emits nothing when there is no cursor', () => {
    expect(keysetClause({ cursor: null, direction: 'DESC', keyCol: 'p.created_at', idCol: 'p.id', paramStart: 2 }))
      .toEqual({ clause: '', params: [] });
  });

  it('builds a newest-first filter with correct param offsets', () => {
    const r = keysetClause({
      cursor: { t: '2026-09-28T00:00:00.000Z', i: 'a1' },
      direction: 'DESC', keyCol: 'p.created_at', idCol: 'p.id', paramStart: 2,
    });
    expect(r.clause).toBe(' AND (p.created_at, p.id) < ($2, $3)');
    expect(r.params).toEqual(['2026-09-28T00:00:00.000Z', 'a1']);
  });

  it('builds an oldest-first filter for ASC lists (tools by name)', () => {
    const r = keysetClause({
      cursor: { t: 'getInvoices', i: 't1' },
      direction: 'ASC', keyCol: 'name', idCol: 'id', paramStart: 2,
    });
    expect(r.clause).toBe(' AND (name, id) > ($2, $3)');
    expect(r.params).toEqual(['getInvoices', 't1']);
  });
});

describe('buildPage', () => {
  const row = (id: string, created_at: string) => ({ id, created_at, name: id });

  it('returns all rows with a null cursor when everything fits', () => {
    const rows = [row('a', '2026-09-28T00:00:00.000Z'), row('b', '2026-09-27T00:00:00.000Z')];
    const page = buildPage(rows, 50, 'created_at', 'id');
    expect(page.items).toHaveLength(2);
    expect(page.meta).toEqual({ limit: 50, has_more: false, next_cursor: null });
  });

  it('trims the probe row and encodes next_cursor from the last item', () => {
    const rows = [row('a', '2026-09-28T00:00:00.000Z'), row('b', '2026-09-27T00:00:00.000Z'), row('c', '2026-09-26T00:00:00.000Z')];
    const page = buildPage(rows, 2, 'created_at', 'id');
    expect(page.items.map((r) => r.id)).toEqual(['a', 'b']);
    expect(page.meta.has_more).toBe(true);
    expect(page.meta.limit).toBe(2);
    expect(page.meta.next_cursor).toBe(encodeCursor('2026-09-27T00:00:00.000Z', 'b'));
  });

  it('handles Date sort keys (node-pg timestamptz parsing)', () => {
    const rows = [
      { id: 'a', created_at: new Date('2026-09-28T00:00:00.000Z') },
      { id: 'b', created_at: new Date('2026-09-27T00:00:00.000Z') },
    ];
    const page = buildPage(rows, 1, 'created_at', 'id');
    expect(page.meta.next_cursor).toBe(encodeCursor('2026-09-28T00:00:00.000Z', 'a'));
    // The cursor survives a parse round-trip.
    const r = parsePagination({ cursor: page.meta.next_cursor! });
    expect(r).toEqual({ ok: true, limit: 50, cursor: { t: '2026-09-28T00:00:00.000Z', i: 'a' } });
  });
});
