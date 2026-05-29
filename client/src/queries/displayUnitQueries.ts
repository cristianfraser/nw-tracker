import { keepPreviousData, type QueryClient } from "@tanstack/react-query";
import {
  fetchDashboardBundle,
  fetchDashboardNavContext,
  fetchPortfolioGroupBundle,
} from "./fetchers";
import { queryKeys, type DisplayUnit } from "./keys";

/** Cached CLP/USD bundles stay warm while toggling display unit. */
export const DISPLAY_UNIT_STALE_MS = 5 * 60_000;

export const displayUnitQueryBehavior = {
  staleTime: DISPLAY_UNIT_STALE_MS,
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
  opts: { group: string; subgroup?: string; unit: DisplayUnit }
): Promise<void> {
  const { group, subgroup, unit } = opts;
  return queryClient.prefetchQuery({
    queryKey: queryKeys.portfolioGroup(group, subgroup, unit),
    queryFn: () => fetchPortfolioGroupBundle({ group, subgroup, unit }),
    staleTime: DISPLAY_UNIT_STALE_MS,
  });
}
