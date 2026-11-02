import { describe, expect, it } from 'vitest';
import { accessClassFor, buildMuseKit, looksLikeMoneyMovement } from './muse-kit.js';

const read = { name: 'getPrice', description: 'Get the price', effect_classes: ['read_only'], confirmation_required: false };
const write = { name: 'createAlert', description: 'Create an alert', effect_classes: ['mutating'], confirmation_required: true, credential_mode: 'api_key', required_scopes: [] };
const unconfirmed = { name: 'updateAlert', description: 'Update an alert', effect_classes: ['mutating'], confirmation_required: false };
const money = { name: 'createTransfer', description: 'Transfer funds', effect_classes: ['mutating'], confirmation_required: true };
const destructive = { name: 'deleteAccount', description: 'Delete an account', effect_classes: ['destructive'], confirmation_required: true };

const input = (snapshots: any[]) => ({
  releaseId: 'r1', version: '1.0.0', connectorName: 'Acme-connector',
  description: 'Agent connector for Acme', mcpEndpoint: 'https://api.test/v1/mcp/p1?version=1.0.0',
  snapshots,
});

describe('Muse submission kit (HK-08)', () => {
  it('maps frozen effect classes to Read/Write/Sensitive-write', () => {
    expect(accessClassFor(read)).toBe('read');
    expect(accessClassFor(write)).toBe('write');
    expect(accessClassFor(destructive)).toBe('sensitive_write');
  });

  it('passes the gate for a read-only release', () => {
    const kit = buildMuseKit(input([read]));
    expect(kit.review_gate.eligible).toBe(true);
    expect(kit.review_gate.reasons).toEqual([]);
    expect(kit.connection).toMatchObject({ type: 'existing_mcp', mcp_endpoint: input([]).mcpEndpoint });
    expect(kit.tools).toEqual([{ name: 'getPrice', description: 'Get the price', access_class: 'read', confirmation: 'never', effects: ['read_only'] }]);
  });

  it('blocks money-movement tools with a reason', () => {
    expect(looksLikeMoneyMovement('createTransfer', 'Transfer funds')).toBe(true);
    expect(looksLikeMoneyMovement('getPrice', 'Get the price')).toBe(false);
    const kit = buildMuseKit(input([read, money]));
    expect(kit.review_gate.eligible).toBe(false);
    expect(kit.review_gate.reasons).toMatchObject([{ tool: 'createTransfer', reason: 'money_movement' }]);
  });

  it('blocks destructive and unconfirmed-write tools with reasons', () => {
    const kit = buildMuseKit(input([destructive, unconfirmed]));
    expect(kit.review_gate.eligible).toBe(false);
    const reasons = kit.review_gate.reasons.map((r) => r.reason).sort();
    expect(reasons).toEqual(['destructive_tool', 'unconfirmed_write']);
  });

  it('collects credential modes for the form checklist', () => {
    const kit = buildMuseKit(input([write]));
    expect(kit.auth.modes).toEqual(['api_key']);
    expect(kit.form_checklist.map((c) => c.field)).toContain('Technical specs → connection type');
  });
});
