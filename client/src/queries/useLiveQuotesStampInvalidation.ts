import { useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { queryKeys } from "./keys";

const STAMP_POLL_MS = 15_000;

/**
 * Refetch server data when the live prices move. The server publishes a stamp once its caches
 * carry a poll's new prices (`GET /api/live-quotes/stamp`); a cheap poll of it replaces waiting
 * out the payloads' 5-minute refetch, which could hold a session's first live prices off the
 * screen for five minutes after the server had them (2026-10-27). Every query is invalidated,
 * as on the Chile day rollover: active ones refetch in place, the rest on next mount. The poll
 * stops while the tab is hidden (react-query's default) and the first stamp seen only sets the
 * baseline.
 */
export function useLiveQuotesStampInvalidation() {
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: queryKeys.liveQuotesStamp(),
    queryFn: () => api.liveQuotesStamp(),
    refetchInterval: STAMP_POLL_MS,
    staleTime: 0,
  });
  const seen = useRef<string | null | undefined>(undefined);
  const stamp = data?.stamp;
  useEffect(() => {
    if (stamp === undefined) return;
    const previous = seen.current;
    seen.current = stamp;
    if (previous === undefined || stamp === previous) return;
    void queryClient.invalidateQueries({
      predicate: (q) => q.queryKey[0] !== queryKeys.liveQuotesStamp()[0],
    });
  }, [stamp, queryClient]);
}
