import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHmac } from 'node:crypto';

vi.mock('./db.js', () => ({
  one: vi.fn(),
  q: vi.fn(),
  exec: vi.fn(),
  withTx: vi.fn(async (fn: any) => fn({ query: vi.fn() })),
  jb: (v: unknown) => JSON.stringify(v),
  uid: () => 'test-uid',
  J: {
    parse: (v: any, fb: any) => {
      if (v == null) return fb;
      if (typeof v !== 'string') return v;
      try { return JSON.parse(v); } catch { return fb; }
    },
  },
}));

import { one, q } from './db.js';
import {
  normalizeTargets,
  defaultTargets,
  targetKey,
  projectTargets,
  createRelease,
} from './release.js';

const oneMock = vi.mocked(one);
const qMock = vi.mocked(q);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('target helpers', () => {
  it('normalizeTargets keeps known ids, dedupes, and returns stable order', () => {
    expect(normalizeTargets(['openai', 'mcp', 'openai', 'bogus'])).toEqual(['mcp', 'openai']);
    expect(normalizeTargets('mcp')).toEqual([]);
    expect(normalizeTargets(null)).toEqual([]);
  });

  it('defaultTargets is the v1 set', () => {
    expect(defaultTargets()).toEqual(['mcp', 'openai', 'muse']);
  });

  it('targetKey sorts for a compact key', () => {
    expect(targetKey(['openai', 'mcp'])).toBe('mcp+openai');
  });

  it('projectTargets falls back to defaults when empty or garbage', () => {
    expect(projectTargets(['muse'])).toEqual(['muse']);
    expect(projectTargets([])).toEqual(['mcp', 'openai', 'muse']);
    expect(projectTargets('nope')).toEqual(['mcp', 'openai', 'muse']);
  });
});

function toolRow(name: string, status = 'tested') {
  return {
    id: `tool-${name}`, name, status, version: 1,
    description: `${name} desc`, purpose: '', eligible_use: '', ineligible_use: '',
    input_schema: JSON.stringify({ type: 'object' }),
    output_schema: JSON.stringify({ type: 'object' }),
    upstream: JSON.stringify({ method: 'GET' }),
    effect_classes: JSON.stringify(['read_only']),
    confirmation_required: false, idempotent: true,
    credential_mode: 'none', required_scopes: JSON.stringify([]),
    provenance: JSON.stringify([]),
  };
}

describe('createRelease', () => {
  it('throws when the project does not exist', async () => {
    oneMock.mockResolvedValue(undefined);
    await expect(createRelease('nope', '1.0.0')).rejects.toThrow('Project not found');
  });

  it('throws when there are no approved/tested tools', async () => {
    oneMock.mockResolvedValueOnce({ id: 'p1', name: 'Acme', targets: ['mcp'] });
    qMock.mockResolvedValueOnce([]);
    await expect(createRelease('p1', '1.0.0')).rejects.toThrow('No approved or tested tools');
  });

  it('blocks release while any tool has not passed evaluation', async () => {
    oneMock.mockResolvedValueOnce({ id: 'p1', name: 'Acme', targets: ['mcp'] });
    qMock.mockResolvedValueOnce([toolRow('a', 'tested'), toolRow('b', 'approved')]);
    await expect(createRelease('p1', '1.0.0')).rejects.toThrow('Release blocked: 1 tool(s) have not passed evaluation (b)');
  });

  it('blocks release when a tool requires a credential that is not connected (AB-05)', async () => {
    oneMock.mockResolvedValueOnce({ id: 'p1', name: 'Acme', targets: ['mcp'] });
    qMock.mockResolvedValueOnce([
      { ...toolRow('getInvoices'), credential_mode: 'none' },
      { ...toolRow('getMe'), credential_mode: 'oauth' },
    ]);
    const err = await createRelease('p1', '1.0.0').catch((e) => e);
    expect(err.message).toBe(
      'Release blocked: 1 tool(s) require a credential that is not connected (getMe (oauth)). Connect a credential before releasing.');
    expect(err).toMatchObject({ code: 'release_credential_required', status: 400 });
  });

  it('scoped release freezes only the selected tools and records the scope', async () => {
    oneMock.mockResolvedValueOnce({ id: 'p1', name: 'Acme', targets: ['mcp'] });
    qMock
      .mockResolvedValueOnce([toolRow('a'), toolRow('b')])
      .mockResolvedValueOnce([{ id: 'tool-a' }]) // membership: only a belongs
      .mockResolvedValue([]); // recovery rules
    const { manifest } = await createRelease('p1', '1.0.0', { toolIds: ['tool-a'] });
    expect(manifest.tools.map((t) => t.name)).toEqual(['a']);
    expect(manifest.provenance.scope).toEqual({ tool_ids: ['tool-a'], tool_count: 1 });
  });

  it('scoped release rejects tools from another project', async () => {
    oneMock.mockResolvedValueOnce({ id: 'p1', name: 'Acme', targets: ['mcp'] });
    qMock
      .mockResolvedValueOnce([toolRow('a')])
      .mockResolvedValueOnce([]); // none of the requested ids belong here
    const err = await createRelease('p1', '1.0.0', { toolIds: ['tool-elsewhere'] }).catch((e) => e);
    expect(err).toMatchObject({ code: 'release_unknown_tools', status: 400 });
  });

  it('credential gate fires before the eval gate — it is the root cause (AB-05)', async () => {
    oneMock.mockResolvedValueOnce({ id: 'p1', name: 'Acme', targets: ['mcp'] });
    qMock.mockResolvedValueOnce([{ ...toolRow('secure', 'approved'), credential_mode: 'api_key' }]);
    await expect(createRelease('p1', '1.0.0')).rejects.toThrow('require a credential that is not connected (secure (api_key))');
  });

  it('passes the credential gate for api_key tools with an active credential (AB-02)', async () => {
    oneMock
      .mockResolvedValueOnce({ id: 'p1', name: 'Acme', targets: ['mcp'] })
      .mockResolvedValueOnce({ id: 'cred-1' }); // active api_key credential
    qMock.mockResolvedValueOnce([{ ...toolRow('secure', 'approved'), credential_mode: 'api_key' }]);
    // Past the credential gate → now blocked by the eval gate instead.
    await expect(createRelease('p1', '1.0.0')).rejects.toThrow('have not passed evaluation');
  });

  it('still blocks oauth tools while an api_key credential unlocks the key tools (AB-03 owns oauth)', async () => {
    oneMock
      .mockResolvedValueOnce({ id: 'p1', name: 'Acme', targets: ['mcp'] })
      .mockResolvedValueOnce({ id: 'cred-1' }); // active api_key credential
    qMock.mockResolvedValueOnce([
      { ...toolRow('secure', 'tested'), credential_mode: 'api_key' },
      { ...toolRow('getMe', 'tested'), credential_mode: 'oauth' },
    ]);
    await expect(createRelease('p1', '1.0.0')).rejects.toThrow('require a credential that is not connected (getMe (oauth))');
  });

  it('rejects a duplicate version for the project', async () => {
    oneMock.mockResolvedValueOnce({ id: 'p1', name: 'Acme', targets: ['mcp'] }).mockResolvedValueOnce({ id: 'r-old' });
    qMock.mockResolvedValueOnce([toolRow('a')]);
    await expect(createRelease('p1', '1.0.0')).rejects.toThrow('Release version 1.0.0 already exists');
  });

  it('builds a signed manifest with recovery rules and a verifiable signature', async () => {
    oneMock.mockResolvedValueOnce({ id: 'p1', name: 'Acme', targets: ['mcp', 'openai'] }).mockResolvedValueOnce(undefined);
    qMock
      .mockResolvedValueOnce([toolRow('getInvoices'), toolRow('createInvoice')]) // tools
      .mockResolvedValueOnce([{ condition: 'RATE_LIMITED', behavior: 'retry_changed', recovery_action: 'backoff_retry', max_attempts: 3, backoff_ms: 2000, user_message: 'slow down' }]) // rules tool 1
      .mockResolvedValueOnce([]); // rules tool 2

    const { id, manifest } = await createRelease('p1', '1.0.0');

    expect(id).toBe('test-uid');
    expect(manifest.connector).toMatchObject({ name: 'Acme-connector', version: '1.0.0', targets: ['mcp', 'openai'] });
    expect(manifest.tools).toHaveLength(2);
    expect(manifest.tools[0].recovery).toEqual([
      { condition: 'RATE_LIMITED', behavior: 'retry_changed', user_message: 'slow down' },
    ]);
    // Signature recomputes from the published bundle hash with the signing secret.
    const expected = createHmac('sha256', 'dev-only-signing-secret')
      .update(`1.0.0:${manifest.integrity.bundle_hash}`).digest('hex');
    expect(manifest.integrity.signature).toBe(expected);
    expect(manifest.integrity.bundle_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('treats Muse as a current (v1) target — no provisional note', async () => {
    oneMock.mockResolvedValueOnce({ id: 'p1', name: 'Acme', targets: ['muse'] }).mockResolvedValueOnce(undefined);
    qMock.mockResolvedValueOnce([toolRow('a')]).mockResolvedValueOnce([]);
    const { manifest } = await createRelease('p1', '2.0.0');
    expect(manifest.connector.targets).toEqual(['muse']);
    expect(manifest.provenance.contract_status).toMatch(/self-describing/);
    expect(manifest.known_limitations.join(' ')).not.toMatch(/v2|PROVISIONAL/);
  });
});
