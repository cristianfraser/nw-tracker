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

/**
 * A query-backed view dims only while it has nothing of its own to show: no data yet
 * (`isPending`, a disabled query included) or the previous page/filter held as placeholder
 * (`isPlaceholderData`). A background refetch — the live-quotes stamp invalidates every query —
 * keeps the view as it is; never dim on `isFetching`.
 */
export function queryShowsLoading(q: { isPending: boolean; isPlaceholderData: boolean }): boolean {
  return q.isPending || q.isPlaceholderData;
}

/**
 * The error a query-backed view shows instead of its content: only when it has no data. A failed
 * background refetch keeps the last data in the query and sets `error`; the view keeps showing
 * that data, and the next refetch recovers. On 2026-11-04 a deploy restarted the server, one
 * refetch failed and «Últimos gastos» was replaced by an error until the next one succeeded.
 */
export function queryLoadError(q: { data: unknown; error: unknown }): unknown {
  return q.data === undefined ? q.error : null;
}
