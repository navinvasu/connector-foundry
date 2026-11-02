// RL-08: promotion-readiness panel state.
//
// A failed checklist fetch must read as a failure with a retry — never as
// eternal "Checking certification…". Loaded checks stay visible across
// background refetches and refetch failures (no flash back to checking).

export type ReadinessPanelStatus = 'checking' | 'failed' | 'shown';

export function readinessPanelStatus(args: {
  readiness: { ready: boolean } | null;
  loading: boolean;
  error: string | null;
}): ReadinessPanelStatus {
  if (args.readiness) return 'shown';
  if (!args.loading && args.error) return 'failed';
  return 'checking';
}
