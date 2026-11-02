import { describe, expect, it } from 'vitest';
import {
  clearDiagnostics, downloadDiagnostics, getDiagnostics, installClickLogging, logAction,
} from './diagnostics';

describe('diagnostics buffer', () => {
  it('records actions newest-last with timestamps', () => {
    clearDiagnostics();
    logAction('api', 'POST /v1/projects/p/agent-tasks/generate', { status: 500 }, 1234, false);
    const entries = getDiagnostics();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'api', ok: false, duration_ms: 1234 });
    expect(typeof entries[0]!.t).toBe('string');
  });

  it('caps the buffer instead of growing forever', () => {
    clearDiagnostics();
    for (let i = 0; i < 310; i++) logAction('click', `button ${i}`);
    const entries = getDiagnostics();
    expect(entries).toHaveLength(300);
    expect(entries[0]!.label).toBe('button 10');
    expect(entries[299]!.label).toBe('button 309');
  });

  it('clears on demand', () => {
    logAction('click', 'x');
    clearDiagnostics();
    expect(getDiagnostics()).toEqual([]);
  });

  it('no-ops safely without a DOM', () => {
    expect(() => installClickLogging()).not.toThrow();
    expect(() => downloadDiagnostics()).not.toThrow();
    expect(() => logAction('click', 'still works')).not.toThrow();
  });
});
