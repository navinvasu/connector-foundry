// FE-05: one state contract for every list screen.
//
// Screens used to invent their own ordering of loading / error / empty,
// which produced the classic bugs this module exists to prevent: an
// "empty" message flashing before the first fetch resolves, and a hard
// failure blanking data the screen already had. The rule:
//
//   - data present            → 'ready'  (a failed *refresh* is the caller's
//                                          inline banner, never a blank page)
//   - no data, still loading  → 'loading' (never flash the empty state)
//   - no data, load failed    → 'error'   (explains itself, offers retry)
//   - no data, load finished  → 'empty'   (explains itself, offers next action)

export type ListState = 'loading' | 'error' | 'empty' | 'ready';

export interface ListStateInput {
  loading: boolean;
  error?: string | null;
  count: number;
}

export function resolveListState({ loading, error, count }: ListStateInput): ListState {
  if (count > 0) return 'ready';
  if (loading) return 'loading';
  if (error) return 'error';
  return 'empty';
}
