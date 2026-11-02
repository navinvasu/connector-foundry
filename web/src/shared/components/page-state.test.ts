import { describe, expect, it } from 'vitest';
import { resolveListState } from './page-state';

// FE-05: the state contract every list screen renders by. The two cases
// that motivated it: never flash "empty" while the first fetch is in
// flight, and never blank data the screen already has on a failed refresh.
describe('resolveListState', () => {
  it('is loading while the first fetch is in flight and nothing is held', () => {
    expect(resolveListState({ loading: true, count: 0 })).toBe('loading');
    expect(resolveListState({ loading: true, error: 'boom', count: 0 })).toBe('loading');
  });

  it('is error when the load failed and nothing is held', () => {
    expect(resolveListState({ loading: false, error: 'boom', count: 0 })).toBe('error');
  });

  it('is empty only once loading finished cleanly with no rows', () => {
    expect(resolveListState({ loading: false, count: 0 })).toBe('empty');
    expect(resolveListState({ loading: false, error: null, count: 0 })).toBe('empty');
  });

  it('stays ready whenever data is held, even mid-refresh or after a failed one', () => {
    expect(resolveListState({ loading: true, count: 3 })).toBe('ready');
    expect(resolveListState({ loading: false, error: 'boom', count: 3 })).toBe('ready');
    expect(resolveListState({ loading: false, count: 1 })).toBe('ready');
  });
});
