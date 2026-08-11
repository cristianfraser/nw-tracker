import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { chileTodayYmd } from "../calendarMonth";

const CHECK_INTERVAL_MS = 60_000;

/**
 * Refetch server data when the Chile calendar day rolls over. Every chart/table payload
 * bakes in "today" (daily grids end at Chile today, monthly blocks carry a live today
 * point), so data fetched before midnight goes stale the moment the day turns — but within
 * `staleTime` nothing refetches, and charts would render yesterday's grid against the new
 * day for up to the refetch interval. On day change, invalidate everything: active queries
 * refetch in place (same cache entries — no per-day query keys), inactive ones refetch on
 * next mount, and `keepPreviousData` plus the chart pipeline's pending-bucket carry keep
 * the old points on screen while the round trip is in flight. Checks on a coarse interval
 * plus visibility/focus so a machine waking after midnight triggers immediately.
 */
export function useChileDayRolloverInvalidation() {
  const queryClient = useQueryClient();
  useEffect(() => {
    let lastYmd = chileTodayYmd();
    const check = () => {
      const now = chileTodayYmd();
      if (now === lastYmd) return;
      lastYmd = now;
      void queryClient.invalidateQueries();
    };
    const intervalId = window.setInterval(check, CHECK_INTERVAL_MS);
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", check);
    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", check);
    };
  }, [queryClient]);
}
