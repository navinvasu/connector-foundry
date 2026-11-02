import { describe, it, expect } from 'vitest';
import { readinessPanelStatus } from './promotionReadiness';

describe('readinessPanelStatus', () => {
  it('shows checking only while the first fetch is in flight', () => {
    expect(readinessPanelStatus({ readiness: null, loading: true, error: null }))
      .toBe('checking');
  });

  it('shows a failed fetch as failed — never as eternal checking', () => {
    expect(readinessPanelStatus({ readiness: null, loading: false, error: 'Request failed: 500' }))
      .toBe('failed');
  });

  it('keeps showing loaded checks during a background refetch', () => {
    expect(readinessPanelStatus({ readiness: { ready: false }, loading: true, error: null }))
      .toBe('shown');
  });

  it('keeps showing loaded checks when a refetch fails', () => {
    expect(readinessPanelStatus({ readiness: { ready: true }, loading: false, error: 'timeout' }))
      .toBe('shown');
  });
});
