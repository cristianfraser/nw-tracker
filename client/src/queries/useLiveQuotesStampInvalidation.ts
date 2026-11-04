import { useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { queryReadsMovedPrice } from "../liveInputs";
import { queryKeys } from "./keys";

const STAMP_POLL_MS = 5_000;

/**
 * Refetch server data when the live prices move. The server publishes a stamp as soon as it
 * writes a moved price (`GET /api/live-quotes/stamp`), and with `?since=` the stamp this client
 * last saw it also says what moved since: tickers, the dollar, the sync dimming — or everything,
 * when it cannot tell. Only the queries whose response read something that moved are
 * invalidated (`queryReadsMovedPrice`, from each response's `X-Live-Inputs`); active ones refetch
 * in place, the rest on next mount, and one without known inputs always does.
 *
 * Polled every 5 s: prices come from Yahoo's stream (2026-11-04), a holding written when it
 * really moves, writes at least 5 s apart, so each stamp carries only the holdings that moved
 * and only their cells flash. The poll stops while the tab is hidden (react-query's default)
 * and the first stamp seen only sets the baseline.
 */
export function useLiveQuotesStampInvalidation() {
  const queryClient = useQueryClient();
  const seen = useRef<string | null | undefined>(undefined);
  const { data } = useQuery({
    queryKey: queryKeys.liveQuotesStamp(),
    queryFn: () => api.liveQuotesStamp(seen.current ?? null),
    refetchInterval: STAMP_POLL_MS,
    staleTime: 0,
  });
  const stamp = data?.stamp;
  const moves = data?.moves ?? null;
  useEffect(() => {
    if (stamp === undefined) return;
    const previous = seen.current;
    seen.current = stamp;
    if (previous === undefined || stamp === previous || moves == null) return;
    void queryClient.invalidateQueries({
      predicate: (q) =>
        q.queryKey[0] !== queryKeys.liveQuotesStamp()[0] && queryReadsMovedPrice(q.state.data, moves),
    });
  }, [stamp, moves, queryClient]);
}
