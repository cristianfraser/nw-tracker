import { keepPreviousData, type QueryClient } from "@tanstack/react-query";
import {
  fetchDashboardBundle,
  fetchDashboardNavContext,
  fetchPortfolioGroupBundle,
} from "./fetchers";
import { queryKeys, type DisplayUnit } from "./keys";

/** Cached CLP/USD bundles stay warm while toggling display unit. */
export const DISPLAY_UNIT_STALE_MS = 5 * 60_000;

/** Align with server `LIVE_QUOTES_INTERVAL_MS` (default 5 min) so account marks refresh after scheduler ticks. */
const LIVE_DASHBOARD_REFETCH_MS = 5 * 60_000;

export const displayUnitQueryBehavior = {
  staleTime: DISPLAY_UNIT_STALE_MS,
  refetchInterval: LIVE_DASHBOARD_REFETCH_MS,
  placeholderData: keepPreviousData,
} as const;

export function prefetchDashboardBundle(queryClient: QueryClient, unit: DisplayUnit): Promise<void> {
  return queryClient.prefetchQuery({
    queryKey: queryKeys.dashboard(unit),
    queryFn: () => fetchDashboardBundle(unit),
    staleTime: DISPLAY_UNIT_STALE_MS,
  });
}

export function prefetchDashboardNavContext(
  queryClient: QueryClient,
  unit: DisplayUnit
): Promise<void> {
  return queryClient.prefetchQuery({
    queryKey: queryKeys.dashboardNav(unit),
    queryFn: () => fetchDashboardNavContext(unit),
    staleTime: DISPLAY_UNIT_STALE_MS,
  });
}

export function prefetchPortfolioGroupBundle(
  queryClient: QueryClient,
  opts: { portfolio_group: string; unit: DisplayUnit }
): Promise<void> {
  const { portfolio_group, unit } = opts;
  return queryClient.prefetchQuery({
    queryKey: queryKeys.portfolioGroup(portfolio_group, undefined, unit),
    queryFn: () => fetchPortfolioGroupBundle({ portfolio_group, unit }),
    staleTime: DISPLAY_UNIT_STALE_MS,
  });
}
