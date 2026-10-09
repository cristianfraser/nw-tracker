import { keepPreviousData, type QueryClient } from "@tanstack/react-query";
import {
  fetchAccountsByPortfolioGroup,
  fetchDashboardBundle,
  fetchDashboardNavContext,
  fetchDashboardNavSnapshot,
  fetchPortfolioGroupBundle,
} from "./fetchers";
import { api } from "../api";
import { hasDashboardNavSnapshotCache } from "./dashboardNavSnapshotCache";
import { queryKeys, type DisplayUnit } from "./keys";

/** Cached CLP/USD bundles stay warm while toggling display unit. */
export const DISPLAY_UNIT_STALE_MS = 5 * 60_000;

/** Align with server `LIVE_QUOTES_INTERVAL_MS` (default 5 min) so account marks refresh after scheduler ticks. */
const LIVE_DASHBOARD_REFETCH_MS = 5 * 60_000;

/**
 * keepPreviousData scoped to one entity. The held payload is offered only while the first
 * `entityKeyLength` elements of the query key are unchanged: a unit, period, range, page or
 * filter change keeps the previous data on screen (the page converts or dims it), while a
 * different group, account or scope starts from its placeholder. Bare `keepPreviousData` is
 * key-agnostic — account A → account B rendered A's bundle under B's title while B loaded.
 */
export function keepPreviousDataSameEntity(queryKey: readonly unknown[], entityKeyLength: number) {
  // Generic in the data type so react-query instantiates it per call site (the hook's TData).
  return <TData,>(
    previousData: TData | undefined,
    previousQuery: { queryKey: readonly unknown[] } | undefined
  ): TData | undefined => {
    if (previousData === undefined || !previousQuery) return undefined;
    const prevKey = previousQuery.queryKey;
    for (let i = 0; i < entityKeyLength; i++) {
      if (!Object.is(prevKey[i], queryKey[i])) return undefined;
    }
    return previousData;
  };
}

/**
 * Query options for the display-unit payloads (bundles, series, tables, flows): warm for five
 * minutes, refetched on the live-quote cadence, and previous data held only across same-entity
 * key changes (see {@link keepPreviousDataSameEntity}).
 */
export function displayUnitQueryBehaviorFor(queryKey: readonly unknown[], entityKeyLength: number) {
  return {
    staleTime: DISPLAY_UNIT_STALE_MS,
    refetchInterval: LIVE_DASHBOARD_REFETCH_MS,
    placeholderData: keepPreviousDataSameEntity(queryKey, entityKeyLength),
  };
}

/** Key-agnostic variant for queries whose key carries no entity (unit or window only). */
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
  if (hasDashboardNavSnapshotCache(unit)) return Promise.resolve();
  return queryClient.prefetchQuery({
    queryKey: queryKeys.dashboardNav(unit),
    queryFn: () => fetchDashboardNavContext(unit),
    staleTime: DISPLAY_UNIT_STALE_MS,
  });
}

export function prefetchDashboardNavSnapshot(
  queryClient: QueryClient,
  unit: DisplayUnit
): Promise<void> {
  if (hasDashboardNavSnapshotCache(unit)) return Promise.resolve();
  return queryClient.prefetchQuery({
    queryKey: queryKeys.dashboardNavSnapshot(unit),
    queryFn: () => fetchDashboardNavSnapshot(unit),
    staleTime: DISPLAY_UNIT_STALE_MS,
  });
}

/** `GET /api/accounts?portfolio_group=…` — group page account list (hover + bundle). */
export function prefetchAccountsByPortfolioGroup(
  queryClient: QueryClient,
  portfolioGroup: string,
  unit: DisplayUnit
): Promise<void> {
  return queryClient.prefetchQuery({
    queryKey: queryKeys.accountsByPortfolioGroup(portfolioGroup, unit),
    queryFn: () => fetchAccountsByPortfolioGroup(portfolioGroup, unit),
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
    queryFn: () => fetchPortfolioGroupBundle({ portfolio_group, unit }, queryClient),
    staleTime: DISPLAY_UNIT_STALE_MS,
  });
}

export function prefetchAccountDetailBundle(
  queryClient: QueryClient,
  accountId: number,
  unit: DisplayUnit
): Promise<void> {
  const id = String(accountId);
  return queryClient.prefetchQuery({
    queryKey: queryKeys.accountDetail(id, unit, "monthly"),
    queryFn: () => api.accountDetailBundle(id, unit, { granularity: "monthly" }),
    staleTime: DISPLAY_UNIT_STALE_MS,
  });
}
