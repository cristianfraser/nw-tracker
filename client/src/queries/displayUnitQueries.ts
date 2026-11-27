import { LIVE_QUOTES_DEFAULT_INTERVAL_MS } from "nw-tracker-contracts/dto/apiConstants";
import type { QueryClient } from "@tanstack/react-query";
import {
  fetchAccountsByPortfolioGroup,
  fetchDashboardBundle,
  fetchDashboardNavSnapshot,
  fetchPortfolioGroupBundle,
} from "./fetchers";
import { api } from "../api";
import { hasDashboardNavSnapshotCache } from "./dashboardNavSnapshotCache";
import { entityKeyLength, queryKeys, type DisplayUnit } from "./keys";

/** Cached CLP/USD bundles stay warm while toggling display unit. */
export const DISPLAY_UNIT_STALE_MS = 5 * 60_000;

/** The server's live-quotes interval default, so account marks refresh after scheduler ticks. */
const LIVE_DASHBOARD_REFETCH_MS = LIVE_QUOTES_DEFAULT_INTERVAL_MS;

/**
 * keepPreviousData scoped to one entity, for the raw list queries (flows lists, the account lists):
 * the held payload is offered only while the first `entityKeyLength` elements of the query key
 * are unchanged, so a page or filter change keeps the previous rows on screen while a different
 * group or account starts from its placeholder. Display-unit surfaces hold through the seam
 * instead (`useHeldX`, `heldUnitPayload.ts`), which ignores react-query's placeholder.
 */
function keepPreviousDataSameEntity(queryKey: readonly unknown[], entityKeyLength: number) {
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

/** {@link keepPreviousDataSameEntity} at the entity length the key was declared with (`keys.ts`). */
export function sameEntityPlaceholder(queryKey: readonly unknown[]) {
  return keepPreviousDataSameEntity(queryKey, entityKeyLength(queryKey));
}

/**
 * Query options for the display-unit payloads (bundles, series, tables, flows): warm for five
 * minutes and refetched on the live-quote cadence.
 */
export const DISPLAY_UNIT_QUERY_BEHAVIOR = {
  staleTime: DISPLAY_UNIT_STALE_MS,
  refetchInterval: LIVE_DASHBOARD_REFETCH_MS,
} as const;

export function prefetchDashboardBundle(queryClient: QueryClient, unit: DisplayUnit): Promise<void> {
  return queryClient.prefetchQuery({
    queryKey: queryKeys.dashboard(unit),
    queryFn: () => fetchDashboardBundle(unit),
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
    queryKey: queryKeys.portfolioGroup(portfolio_group, unit),
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
