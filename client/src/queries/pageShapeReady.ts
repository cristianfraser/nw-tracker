import type { AccountListRow, DashboardNavSnapshotResponse } from "../types";

/** Block first paint only when neither accounts nor nav snapshot shape exists yet. */
export function isPageShapeLoading(
  accountsPending: boolean,
  accounts: AccountListRow[] | undefined,
  navSnapshotPending: boolean,
  navSnapshot: DashboardNavSnapshotResponse | undefined
): boolean {
  if (accounts !== undefined || navSnapshot !== undefined) return false;
  return accountsPending || navSnapshotPending;
}

/** Dim page body while bundle loads, including display-unit switch with prior-unit placeholder data. */
export function isBundleContentLoading(opts: {
  isPending: boolean;
  isPlaceholderData: boolean;
  bundleReady: boolean;
}): boolean {
  const { isPending, isPlaceholderData, bundleReady } = opts;
  if (isPlaceholderData && bundleReady) return true;
  return isPending || !bundleReady;
}

/** Use fetched bundle for card/chart content; skip stale prior-unit data during unit switch. */
export function useRealBundleForContent(
  isPlaceholderData: boolean,
  bundleReady: boolean
): boolean {
  return bundleReady && !isPlaceholderData;
}
