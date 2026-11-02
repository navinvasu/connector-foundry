import { describe, it, expect, vi, beforeEach } from 'vitest';

let uidN = 0;
vi.mock('./db.js', () => ({
  q: vi.fn(),
  withTx: vi.fn(async (fn: any) => fn({ query: vi.fn() })),
  jb: (v: unknown) => JSON.stringify(v),
  uid: () => `uid-${++uidN}`,
  audit: vi.fn(),
}));

import { q, withTx, audit } from './db.js';
import { compileProject } from './pipeline.js';

const qMock = vi.mocked(q);
const withTxMock = vi.mocked(withTx);
const auditMock = vi.mocked(audit);

const billingSpec = {
  openapi: '3.0.3',
  info: { title: 'Acme Billing', version: '1.2.0' },
  servers: [{ url: 'https://api.acme.test' }],
  paths: {
    '/invoices': {
      get: {
        operationId: 'list_invoices', summary: 'List invoices',
        parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer' } }],
        responses: { '200': { description: 'ok' } },
      },
      post: {
        operationId: 'create_invoice', summary: 'Create invoice',
        responses: { '201': { description: 'created' } },
      },
    },
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  uidN = 0;
  // withTx mock needs a fresh fake client per call so queries can be inspected.
  withTxMock.mockImplementation(async (fn: any) => {
    // Real pg returns a result with rowCount; the compile loop reads it to
    // tell an inserted tool row from a conflict-skipped one.
    const client = { query: vi.fn(async () => ({ rowCount: 1 })) };
    (withTxMock as any).lastClient = client;
    return fn(client);
  });
});

function mockImport(existingNames: Array<{ name: string }> = []) {
  // Queue order mirrors compileProject's reads: operations, api_sources,
  // then the canonical_tools names used by the dedupe pre-check.
  qMock
    .mockResolvedValueOnce([{ id: 'op-1' }, { id: 'op-2' }]) // operations
    .mockResolvedValueOnce([{ location: 'upload:acme.yaml', spec_body: billingSpec }]) // api_sources
    .mockResolvedValueOnce(existingNames); // canonical_tools names (dedupe pre-check)
}

describe('compileProject', () => {
  it('compiles imported operations into canonical tools', async () => {
    mockImport();
    const progress: Array<[number, number, string]> = [];
    const out = await compileProject('p1', (d, t, n) => { progress.push([d, t, n]); });

    expect(out.tools_created).toBe(2);
    expect(out.tool_ids).toHaveLength(2);

    const client = (withTxMock as any).lastClient;
    const toolInserts = client.query.mock.calls.filter((c: any[]) => String(c[0]).includes('INSERT INTO canonical_tools'));
    const ruleInserts = client.query.mock.calls.filter((c: any[]) => String(c[0]).includes('INSERT INTO tool_recovery_rules'));
    const normalized = client.query.mock.calls.filter((c: any[]) => String(c[0]).includes("SET status = 'normalized'"));

    expect(toolInserts).toHaveLength(2);
    expect(toolInserts[0][1][2]).toBe('listInvoices'); // name column
    expect(ruleInserts).toHaveLength(8); // 4 default recovery rules per tool
    expect(normalized).toHaveLength(1);

    expect(progress).toEqual([
      [1, 2, 'Compiling GET /invoices'],
      [2, 2, 'Compiling POST /invoices'],
    ]);
    expect(auditMock).toHaveBeenCalledWith('p1', 'tools.compiled', 'project', 'p1', { tools: 2 });
  });

  it('throws when there are no imported operations', async () => {
    qMock.mockResolvedValueOnce([]);
    await expect(compileProject('p1')).rejects.toThrow('No imported operations to compile');
    expect(withTxMock).not.toHaveBeenCalled();
  });

  it('throws when no import spec snapshots exist', async () => {
    // Reads run operations, then api_sources — the names pre-check never
    // runs because the sources read throws first.
    qMock
      .mockResolvedValueOnce([{ id: 'op-1' }])
      .mockResolvedValueOnce([]);
    await expect(compileProject('p1')).rejects.toThrow('No import specs found');
  });

  it('works without a progress callback', async () => {
    mockImport();
    const out = await compileProject('p1');
    expect(out.tools_created).toBe(2);
  });

  it('re-compiling the same spec creates no duplicate tools', async () => {
    mockImport([{ name: 'listInvoices' }, { name: 'createInvoice' }]);
    const out = await compileProject('p1');
    expect(out.tools_created).toBe(0);
    expect(out.tool_ids).toEqual([]);
    const client = (withTxMock as any).lastClient;
    const toolInserts = client.query.mock.calls.filter((c: any[]) => String(c[0]).includes('INSERT INTO canonical_tools'));
    const ruleInserts = client.query.mock.calls.filter((c: any[]) => String(c[0]).includes('INSERT INTO tool_recovery_rules'));
    expect(toolInserts).toHaveLength(0);
    expect(ruleInserts).toHaveLength(0);
  });

  it('compiles only the operations that are new since the last compile', async () => {
    mockImport([{ name: 'listInvoices' }]);
    const out = await compileProject('p1');
    expect(out.tools_created).toBe(1);
    const client = (withTxMock as any).lastClient;
    const toolInserts = client.query.mock.calls.filter((c: any[]) => String(c[0]).includes('INSERT INTO canonical_tools'));
    expect(toolInserts).toHaveLength(1);
    expect(toolInserts[0][1][2]).toBe('createInvoice'); // name column
  });
});
