import type { HeldUnitView } from "./heldUnitPayload";

/**
 * A page bundle to draw: the payload on screen (the requested unit's or the one held,
 * {@link HeldUnitView}) once it carries what the page reads; `undefined` while there is none —
 * the page draws its zero placeholder, which is only for a page with nothing to show yet.
 * `loading` dims while the content is held or missing; `live` is the requested unit's own ready
 * payload, the only one side effects (stored snapshots and shells) may write.
 */
export function bundleContent<T>(
  payload: HeldUnitView<T>,
  ready: (data: T) => boolean
): { content: T | undefined; loading: boolean; live: T | undefined } {
  const content = payload.data !== undefined && ready(payload.data) ? payload.data : undefined;
  const live = payload.live !== undefined && ready(payload.live) ? payload.live : undefined;
  return { content, loading: payload.loading || content === undefined, live };
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

/**
 * A Diario chart draws only daily data: with no daily payload on hand (none of the request's own
 * and none held) the chart gets no data and shows its pending frame — title row and controls over
 * an empty box — never the monthly block. A held daily payload (the previous unit's or range's) is
 * drawn, dimmed, in its own unit.
 */
export function dailyPayloadPending(isDaily: boolean, shown: { data: unknown }): boolean {
  return isDaily && shown.data === undefined;
}
