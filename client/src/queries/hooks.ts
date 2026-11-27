import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { api } from "../api";
import {
  fetchAccountsByPortfolioGroup,
  fetchDashboardBundle,
  fetchDashboardNavContext,
  fetchDashboardNavSnapshot,
  fetchPortfolioGroupBundle,
} from "./fetchers";
import {
  hasDashboardNavSnapshotCache,
  navSnapshotCoversNavTree,
  mergeNavContextIntoSnapshotCache,
  readDashboardNavSnapshotCache,
  writeDashboardNavSnapshotCache,
} from "./dashboardNavSnapshotCache";
import {
  DISPLAY_UNIT_QUERY_BEHAVIOR,
  DISPLAY_UNIT_STALE_MS,
  sameEntityPlaceholder,
} from "./displayUnitQueries";
import { queryKeys, type AccountFlowsScope, type DisplayUnit } from "./keys";
import { invalidateResources, resources } from "./resources";
import { useHeldUnitQuery, type HeldUnitQuery } from "./heldUnitPayload";
import { buildGroupPageShellFromNav } from "../placeholders/groupPageShellFromNav";
import { hasGroupPageShellCache, readGroupPageShellCache } from "./groupPageShellCache";
import { readSidebarNavCache, writeSidebarNavCache } from "./sidebarNavCache";
import type { DailySeriesResponse, ExpensesSpentParams, NavTreeNodeDto } from "../types";
import { setCurrencyRegistry } from "../format";
import type { DashboardBundle, DashboardNavContext, PortfolioGroupBundle } from "./fetchers";

/** Snapshots read from localStorage (placeholders), as opposed to live server payloads. */
const navSnapshotsFromLocalCache = new WeakSet<object>();

/** A unit reads its own cached snapshot only — a CLP cache never stands in for USD. */
function readNavSnapshotCacheForUnit(unit: DisplayUnit) {
  const snapshot = readDashboardNavSnapshotCache(unit);
  if (!snapshot) return undefined;
  navSnapshotsFromLocalCache.add(snapshot);
  return snapshot;
}

export { hasDashboardNavSnapshotCache } from "./dashboardNavSnapshotCache";

/*
 * A display-unit query is drawn through `useHeldX` (the query as a surface shows it across a unit
 * switch, `heldUnitPayload.ts`), whose first argument is the call site's surface id; key, fetcher,
 * `enabled` and the query's cadence are stated once, in the hook (in an options function when a
 * raw `useX` shares them: only where something reads the query without drawing it, a warm-up).
 * The bundles, series, tables, glances and the flows overview refetch on
 * `DISPLAY_UNIT_QUERY_BEHAVIOR`; the other flows,
 * expenses, market and rates pages keep react-query's defaults (the ticker and watchlist their
 * minute poll).
 */

function dashboardBundleOptions(unit: DisplayUnit, enabled: boolean) {
  const queryKey = queryKeys.dashboard(unit);
  return {
    queryKey,
    queryFn: () => fetchDashboardBundle(unit),
    enabled,
    ...DISPLAY_UNIT_QUERY_BEHAVIOR,
  };
}

export function useHeldDashboardBundle(surface: string, unit: DisplayUnit): HeldUnitQuery<DashboardBundle> {
  return useHeldUnitQuery(dashboardBundleOptions(unit, true), unit, surface);
}

function dashboardOverviewDailyOptions(unit: DisplayUnit, days: number, enabled: boolean) {
  const queryKey = queryKeys.dashboardOverviewDaily(unit, days);
  return {
    queryKey,
    queryFn: () => api.dashboardOverviewDaily(unit, days),
    enabled,
    ...DISPLAY_UNIT_QUERY_BEHAVIOR,
  };
}

export function useHeldDashboardOverviewDaily(surface: string, unit: DisplayUnit, days: number, enabled: boolean) {
  return useHeldUnitQuery(dashboardOverviewDailyOptions(unit, days, enabled), unit, surface);
}

type DailySeriesScope = { portfolioGroup?: string; accountId?: number };

function dailySeriesScopeKey(scope: DailySeriesScope): string {
  return scope.portfolioGroup
    ? `pg:${scope.portfolioGroup}`
    : scope.accountId != null
      ? `account:${scope.accountId}`
      : "";
}

function dailySeriesOptions(
  scope: DailySeriesScope,
  unit: DisplayUnit,
  days: number,
  enabled: boolean,
  opts?: { perfLevels?: boolean }
) {
  const scopeKey = dailySeriesScopeKey(scope);
  const perfLevels = opts?.perfLevels === true;
  const queryKey = queryKeys.dailySeries(scopeKey, perfLevels ? "perf" : "base", unit, days);
  return {
    queryKey,
    queryFn: () => api.dailySeries(unit, scope, days, { perfLevels }),
    enabled: enabled && scopeKey !== "",
    ...DISPLAY_UNIT_QUERY_BEHAVIOR,
  };
}

/**
 * Daily series for one group page or account (day period view: chart + detalle por día), as a
 * surface shows it: held across a unit or range change, in its own unit. `perfLevels` asks for the
 * day-mode P/L levels (`perf_levels`) the P/L combos pick.
 */
export function useHeldDailySeries(
  surface: string,
  scope: DailySeriesScope,
  unit: DisplayUnit,
  days: number,
  enabled = true,
  opts?: { perfLevels?: boolean }
): HeldUnitQuery<DailySeriesResponse> {
  return useHeldUnitQuery(dailySeriesOptions(scope, unit, days, enabled, opts), unit, surface);
}

function dashboardNavContextOptions(unit: DisplayUnit, root: string | null, enabled: boolean) {
  const queryKey = queryKeys.dashboardNav(root ?? "", unit);
  return {
    queryKey,
    queryFn: async () => {
      const ctx = await fetchDashboardNavContext(unit, root!);
      mergeNavContextIntoSnapshotCache(unit, ctx);
      return ctx;
    },
    enabled: enabled && root != null,
    ...DISPLAY_UNIT_QUERY_BEHAVIOR,
  };
}

/**
 * One page's nav context (`root` = the page's nav node slug; null = not known yet, nothing
 * fetched), held across a unit switch in its own unit. Its figures are merged into the stored
 * snapshot, so a reload of that page paints today's cards, not the ones another page saw on its
 * last visit.
 */
export function useHeldDashboardNavContext(
  surface: string,
  unit: DisplayUnit,
  root: string | null,
  enabled: boolean
): HeldUnitQuery<DashboardNavContext> {
  return useHeldUnitQuery(dashboardNavContextOptions(unit, root, enabled), unit, surface);
}

const DASHBOARD_NAV_SNAPSHOT_STALE_MS = 10 * 60_000;

/** Home card strip shape (accounts + layout); cached in localStorage between visits. */
export function useDashboardNavSnapshot(unit: DisplayUnit, enabled = true) {
  const queryClient = useQueryClient();
  const { data: sidebarNav } = useSidebarNav();
  const cachedStrip = hasDashboardNavSnapshotCache(unit);
  const query = useQuery({
    queryKey: queryKeys.dashboardNavSnapshot(unit),
    queryFn: async () => {
      const snapshot = await fetchDashboardNavSnapshot(unit);
      writeDashboardNavSnapshotCache(unit, snapshot);
      return snapshot;
    },
    initialData: () => (cachedStrip ? readNavSnapshotCacheForUnit(unit) : undefined),
    // A stored copy counts as updated at 0: older than anything fetched, so across a unit switch
    // it never replaces cards already on screen (`heldUnitPayload.ts`), only paints an empty strip.
    initialDataUpdatedAt: cachedStrip ? 0 : undefined,
    // With a cached strip this query never refetches; freshness relies on the live payloads
    // re-writing the cache: DashboardPage from its page bundle, the nav-context fetch.
    enabled: enabled && !cachedStrip,
    // Keyed on the unit: a unit change holds nothing (a CLP snapshot has no USD fields). It paints
    // only a strip with nothing to show; the pages' strips follow their held payloads.
    ...DISPLAY_UNIT_QUERY_BEHAVIOR,
    staleTime: DASHBOARD_NAV_SNAPSHOT_STALE_MS,
    gcTime: DASHBOARD_NAV_SNAPSHOT_STALE_MS,
  });
  // A placeholder read from localStorage before the nav tree grew a node must never reach the
  // cards (requireNavCardMetrics fails fast on the missing slug). Hide it and reset the query:
  // the storage entry is already gone, so the reset fetches the live snapshot. Live payloads are
  // never second-guessed here — a slug missing from one is a server bug and still throws.
  const staleCachedSnapshot =
    query.data != null &&
    navSnapshotsFromLocalCache.has(query.data) &&
    !navSnapshotCoversNavTree(query.data.card_metrics_by_slug, sidebarNav);
  useEffect(() => {
    if (!staleCachedSnapshot) return;
    void queryClient.resetQueries({ queryKey: queryKeys.dashboardNavSnapshot(unit), exact: true });
  }, [staleCachedSnapshot, queryClient, unit]);
  return staleCachedSnapshot ? { ...query, data: undefined } : query;
}

function groupConsolidatedTablesOptions(portfolioGroup: string, unit: DisplayUnit, enabled: boolean) {
  const queryKey = queryKeys.groupConsolidatedTables(portfolioGroup, unit);
  return {
    queryKey,
    queryFn: () => api.groupConsolidatedTables(portfolioGroup, unit),
    enabled: enabled && Boolean(portfolioGroup),
    ...DISPLAY_UNIT_QUERY_BEHAVIOR,
  };
}

export function useHeldGroupConsolidatedTables(surface: string, portfolioGroup: string, unit: DisplayUnit, enabled: boolean) {
  return useHeldUnitQuery(groupConsolidatedTablesOptions(portfolioGroup, unit, enabled), unit, surface);
}

function groupPeriodReturnsOptions(portfolioGroup: string, unit: DisplayUnit, enabled: boolean) {
  const queryKey = queryKeys.groupPeriodReturns(portfolioGroup, unit);
  return {
    queryKey,
    queryFn: () => api.groupPeriodReturns(portfolioGroup, unit),
    enabled: enabled && Boolean(portfolioGroup),
    ...DISPLAY_UNIT_QUERY_BEHAVIOR,
  };
}

export function useHeldGroupPeriodReturns(surface: string, portfolioGroup: string, unit: DisplayUnit, enabled: boolean) {
  return useHeldUnitQuery(groupPeriodReturnsOptions(portfolioGroup, unit, enabled), unit, surface);
}

/**
 * Home «Últimos movimientos»: the newest expense lines and income credits, interleaved; held across
 * a unit switch (the payload carries no `unit`: the view's `unit` is the one it was requested in).
 */
export function useHeldLatestMovements(surface: string, limit: number, unit: DisplayUnit) {
  const queryKey = queryKeys.latestMovements(limit, unit);
  return useHeldUnitQuery({ queryKey, queryFn: () => api.latestMovements(limit, unit) }, unit, surface);
}

/**
 * One server page of the consolidated detalle table (dashboard net_worth), as the table shows it:
 * held across a unit, page or period change. `installmentMode`: the expense mode net worth's
 * income and expenses are counted in.
 */
export function useHeldGroupConsolidatedMonthlyPage(
  surface: string,
  portfolioGroup: string,
  unit: DisplayUnit,
  period: "month" | "year",
  page: number,
  pageSize: number,
  enabled: boolean,
  installmentMode: "split" | "total"
) {
  const queryKey = queryKeys.groupConsolidatedMonthlyPage(portfolioGroup, unit, period, page, pageSize, installmentMode);
  return useHeldUnitQuery(
    {
      queryKey,
      queryFn: () => api.groupConsolidatedMonthly(portfolioGroup, unit, { page, pageSize, period, installmentMode }),
      enabled: enabled && Boolean(portfolioGroup),
      ...DISPLAY_UNIT_QUERY_BEHAVIOR,
    },
    unit,
    surface
  );
}

/** `GET /api/accounts?portfolio_group=…` — group/dashboard page shape (account list). */
export function useAccountsByPortfolioGroup(
  portfolioGroup: string,
  unit: DisplayUnit,
  enabled = true
) {
  return useQuery({
    queryKey: queryKeys.accountsByPortfolioGroup(portfolioGroup, unit),
    queryFn: () => fetchAccountsByPortfolioGroup(portfolioGroup, unit),
    enabled: enabled && Boolean(portfolioGroup),
    ...DISPLAY_UNIT_QUERY_BEHAVIOR,
    placeholderData: sameEntityPlaceholder(queryKeys.accountsByPortfolioGroup(portfolioGroup, unit)),
    staleTime: DISPLAY_UNIT_STALE_MS,
    gcTime: DISPLAY_UNIT_STALE_MS,
  });
}

/** A group page's bundle as the page shows it: held across a unit switch, in its own unit. */
export function useHeldPortfolioGroupBundle(surface: string, opts: {
  portfolio_group: string;
  unit: DisplayUnit;
  enabled?: boolean;
}): HeldUnitQuery<PortfolioGroupBundle> {
  return useHeldUnitQuery(portfolioGroupBundleOptions(useQueryClient(), opts), opts.unit, surface);
}

function portfolioGroupBundleOptions(
  queryClient: ReturnType<typeof useQueryClient>,
  opts: { portfolio_group: string; unit: DisplayUnit; enabled?: boolean }
) {
  const { portfolio_group, unit, enabled = true } = opts;
  const queryKey = queryKeys.portfolioGroup(portfolio_group, unit);
  return {
    queryKey,
    queryFn: () => fetchPortfolioGroupBundle({ portfolio_group, unit }, queryClient),
    enabled: enabled && Boolean(portfolio_group),
    ...DISPLAY_UNIT_QUERY_BEHAVIOR,
  };
}

const GROUP_PAGE_SHELL_STALE_MS = 10 * 60_000;

/** Local-only group shape for cards: localStorage cache or nav-tree synthesis. */
export function useGroupPageShell(opts: {
  portfolioGroup: string;
  unit: DisplayUnit;
  navNode: NavTreeNodeDto | null | undefined;
  enabled?: boolean;
}) {
  const { portfolioGroup, unit, navNode, enabled = true } = opts;
  const cachedShell = hasGroupPageShellCache(portfolioGroup, unit);
  return useQuery({
    queryKey: queryKeys.groupPageShell(portfolioGroup, unit),
    queryFn: () => {
      const cached = readGroupPageShellCache(portfolioGroup, unit);
      if (cached) return cached;
      if (!navNode) {
        throw new Error("useGroupPageShell: navNode required when cache is empty");
      }
      return buildGroupPageShellFromNav(navNode);
    },
    initialData: () =>
      cachedShell ? readGroupPageShellCache(portfolioGroup, unit) : undefined,
    initialDataUpdatedAt: cachedShell ? Date.now() : undefined,
    enabled: enabled && Boolean(portfolioGroup && navNode) && !cachedShell,
    ...DISPLAY_UNIT_QUERY_BEHAVIOR,
    placeholderData: sameEntityPlaceholder(queryKeys.groupPageShell(portfolioGroup, unit)),
    staleTime: GROUP_PAGE_SHELL_STALE_MS,
    gcTime: GROUP_PAGE_SHELL_STALE_MS,
  });
}

export function useSidebarNav() {
  const cached = readSidebarNavCache();
  return useQuery({
    queryKey: queryKeys.sidebarNav(),
    queryFn: async () => {
      const data = await api.sidebarNav();
      writeSidebarNavCache(data);
      return data;
    },
    ...(cached ? { initialData: cached, initialDataUpdatedAt: 0 } : {}),
    staleTime: 60_000,
    refetchOnMount: true,
  });
}

export function usePanelNetWorthTree() {
  return useQuery({
    queryKey: queryKeys.panelNetWorthTree(),
    queryFn: () => api.panelNetWorthTree(),
    staleTime: 60_000,
  });
}

export function useAccountsAll() {
  return useQuery({
    queryKey: queryKeys.accountsAll(),
    queryFn: () => api.accountsAll(),
    staleTime: 60_000,
  });
}

/**
 * The loaded currencies (`GET /api/currencies`): the display-unit picker's options and every
 * money format's symbol and minor digits (recorded in `format.ts` as they arrive).
 */
export function useCurrencies() {
  return useQuery({
    queryKey: queryKeys.currencies(),
    queryFn: async () => {
      const data = await api.currencies();
      setCurrencyRegistry(data.currencies);
      return data;
    },
    staleTime: Infinity,
  });
}

const MARKET_TICKER_MS = 60_000;

function marketTickerOptions(unit: DisplayUnit) {
  return {
    queryKey: queryKeys.marketTicker(unit),
    queryFn: () => api.marketTicker(unit),
    staleTime: MARKET_TICKER_MS,
    refetchInterval: MARKET_TICKER_MS,
  };
}

/** Marquee snapshot in the display unit (values convert server-side; the key carries the unit);
 * the raw query, for a page that only warms it. */
export function useMarketTicker(unit: DisplayUnit) {
  return useQuery(marketTickerOptions(unit));
}

/** {@link useMarketTicker} as the marquee shows it: held across a unit switch, in its own unit. */
export function useHeldMarketTicker(surface: string, unit: DisplayUnit) {
  return useHeldUnitQuery(marketTickerOptions(unit), unit, surface);
}

/** The watchlist page in the display unit, held across a unit switch, in its own unit. */
export function useHeldWatchlist(surface: string, unit: DisplayUnit) {
  return useHeldUnitQuery(
    {
      queryKey: queryKeys.watchlist(unit),
      queryFn: () => api.watchlist(unit),
      staleTime: MARKET_TICKER_MS,
      refetchInterval: MARKET_TICKER_MS,
    },
    unit,
    surface
  );
}

/**
 * Yahoo's matches for the watchlist add box. `query` is the caller's debounced text; nothing
 * is asked until it has a character.
 */
export function useWatchlistSymbolSearch(query: string) {
  const q = query.trim();
  return useQuery({
    queryKey: queryKeys.watchlistSymbolSearch(q),
    queryFn: () => api.searchWatchlistSymbols(q),
    enabled: q.length > 0,
    staleTime: 5 * 60_000,
  });
}

function invalidateWatchlistQueries(queryClient: ReturnType<typeof useQueryClient>): void {
  void invalidateResources(queryClient, resources.watchlist());
}

export function usePatchWatchlistMarquee() {
  const queryClient = useQueryClient();
  type Snapshot = [readonly unknown[], import("../types").WatchlistResponse | undefined][];
  return useMutation({
    mutationFn: ({ id, show_in_marquee }: { id: number; show_in_marquee: number }) =>
      api.patchWatchlistRow(id, { show_in_marquee }),
    onMutate: async ({ id, show_in_marquee }) => {
      // Both units' copies get the optimistic flag, whichever the page is showing.
      await queryClient.cancelQueries({ queryKey: queryKeys.watchlistAll() });
      const prev: Snapshot = queryClient.getQueriesData<import("../types").WatchlistResponse>({
        queryKey: queryKeys.watchlistAll(),
      });
      const patchRow = (rows: import("../types").WatchlistRow[]) =>
        rows.map((r) => (r.id === id ? { ...r, show_in_marquee } : r));
      queryClient.setQueriesData<import("../types").WatchlistResponse>(
        { queryKey: queryKeys.watchlistAll() },
        (data) => (data ? { ...data, app: patchRow(data.app), manual: patchRow(data.manual) } : data)
      );
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      for (const [key, data] of ctx?.prev ?? []) queryClient.setQueryData(key, data);
    },
    onSettled: () => invalidateWatchlistQueries(queryClient),
  });
}

export function useAddWatchlistTicker() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (ticker: string) => api.addWatchlistTicker(ticker),
    onSuccess: () => invalidateWatchlistQueries(queryClient),
  });
}

export function useDeleteWatchlistRow() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.deleteWatchlistRow(id),
    onSuccess: () => invalidateWatchlistQueries(queryClient),
  });
}

/** The rates page's series, held across a unit switch, in its own unit. */
export function useHeldMarketSeries(surface: string, unit: DisplayUnit) {
  return useHeldUnitQuery({ queryKey: queryKeys.marketSeries(unit), queryFn: () => api.marketSeries(unit) }, unit, surface);
}

/** The rates page's glances; reads live rates, so the stamp poll refetches it on a move. Held across a unit switch. */
export function useHeldRatesGlance(surface: string, unit: DisplayUnit) {
  return useHeldUnitQuery({ queryKey: queryKeys.ratesGlance(unit), queryFn: () => api.ratesGlance(unit) }, unit, surface);
}

/** The buy / sell rates waiting for review, by year. */
export function useFxBidAskGaps() {
  return useQuery({
    queryKey: queryKeys.fxBidAskGaps(),
    queryFn: () => api.fxBidAskGaps(),
  });
}

export function useMortgageUfReminder(enabled = true) {
  return useQuery({
    queryKey: queryKeys.mortgageUfReminder(),
    queryFn: () => api.mortgageUfReminder(),
    enabled,
    staleTime: 5 * 60_000,
  });
}

export function useMessagesUnreadCount() {
  return useQuery({
    queryKey: queryKeys.messagesUnread(),
    queryFn: () => api.messagesUnreadCount(),
    staleTime: MARKET_TICKER_MS,
    refetchInterval: MARKET_TICKER_MS,
  });
}

export function useMessages(kind: "notification" | "log") {
  return useQuery({
    queryKey: queryKeys.messages(kind),
    queryFn: () => api.messages(kind),
  });
}

export function useUsageReport(days: import("../types").UsageReportWindow) {
  return useQuery({
    queryKey: queryKeys.usageReport(days),
    queryFn: () => api.usageReport(days),
    placeholderData: keepPreviousData,
  });
}

export function useUsageEndpointTrend(
  series: (import("../types").UsageEndpointSeries & { key: string }) | null,
  days: import("../types").UsageReportWindow
) {
  return useQuery({
    queryKey: queryKeys.usageEndpointTrend(series?.key ?? "", days),
    queryFn: () => api.usageEndpointTrend(series!, days),
    enabled: series != null,
  });
}

export function useSyncStatus() {
  return useQuery({
    queryKey: queryKeys.syncStatus(),
    queryFn: () => api.syncStatus(),
    refetchInterval: 15_000,
  });
}

/** Polls fast while a run is in flight, so the page sees it finish. */
export function useIngestRunsStatus() {
  return useQuery({
    queryKey: queryKeys.ingestRunsStatus(),
    queryFn: () => api.ingestRunsStatus(),
    refetchInterval: (query) => (query.state.data?.in_flight ? 5_000 : 30_000),
  });
}

export function useStartIngestRunMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (kind: import("../types").IngestRunKind) => api.startIngestRun(kind),
    onSuccess: (data) => {
      queryClient.setQueryData(queryKeys.ingestRunsStatus(), data);
      void invalidateResources(queryClient, resources.jobQueue());
    },
  });
}

/** The job queue; polls fast while anything runs or waits. */
export function useJobQueue() {
  return useQuery({
    queryKey: queryKeys.jobQueue(),
    queryFn: () => api.jobQueue(),
    refetchInterval: (query) => (query.state.data && (query.state.data.running.length || query.state.data.queued.length) ? 5_000 : 30_000),
  });
}

export function useJobActionMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action }: { id: number; action: "cancel" | "retry" }) => (action === "cancel" ? api.cancelJob(id) : api.retryJob(id)),
    onSuccess: (data) => {
      queryClient.setQueryData(queryKeys.jobQueue(), data);
      void invalidateResources(queryClient, resources.ingestRuns());
    },
  });
}

export function useImportSyncDocumentCoverage() {
  return useQuery({
    queryKey: queryKeys.importSyncDocumentCoverage(),
    queryFn: () => api.importSyncDocumentCoverage(),
  });
}

/** A workbook's sheets, for the document viewer (mounted only while it shows one). */
export function useImportSyncSheetPreview(sheetHref: string) {
  return useQuery({
    queryKey: queryKeys.importSyncSheetPreview(sheetHref),
    queryFn: () => api.importSyncSheetPreview(sheetHref),
  });
}

export function useGenericUniqueMerchants() {
  return useQuery({
    queryKey: queryKeys.genericUniqueMerchants(),
    queryFn: () => api.genericUniqueMerchants(),
  });
}

export function useCreateGenericUniqueMerchantMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (merchant: string) => api.createGenericUniqueMerchant(merchant),
    onSuccess: () => {
      void invalidateResources(queryClient, resources.genericUniqueMerchants());
    },
  });
}

export function useUpdateGenericUniqueMerchantMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, merchant }: { id: number; merchant: string }) =>
      api.updateGenericUniqueMerchant(id, merchant),
    onSuccess: () => {
      void invalidateResources(queryClient, resources.genericUniqueMerchants());
    },
  });
}

export function useDeleteGenericUniqueMerchantMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.deleteGenericUniqueMerchant(id),
    onSuccess: () => {
      void invalidateResources(queryClient, resources.genericUniqueMerchants());
    },
  });
}

export function useSyncForceStaleMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (source: import("../types").SyncSourceId) => api.syncForceStale(source),
    onSuccess: (data) => {
      queryClient.setQueryData(queryKeys.syncStatus(), data);
    },
  });
}

export function useMarkMessagesReadMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.markMessagesRead(),
    onSuccess: () => {
      void invalidateResources(queryClient, resources.messagesUnread());
    },
  });
}

/** The income page payload with its aggregates in `unit`, held across a unit switch, in its own unit. */
export function useHeldIncome(surface: string, unit: DisplayUnit) {
  return useHeldUnitQuery({ queryKey: queryKeys.incomePage(unit), queryFn: () => api.income(unit) }, unit, surface);
}

/** The /flows/deposits page in `unit`, held across a unit switch, in its own unit. */
export function useHeldFlowsDeposits(surface: string, unit: DisplayUnit) {
  return useHeldUnitQuery({ queryKey: queryKeys.flowsDepositsPage(unit), queryFn: () => api.flowsDeposits(unit) }, unit, surface);
}

/** The /flows P/L page in `unit`, held across a unit or Diario window change, in its own unit. */
export function useHeldFlowsPl(surface: string, unit: DisplayUnit, days?: number) {
  return useHeldUnitQuery({ queryKey: queryKeys.flowsPl(unit, days), queryFn: () => api.flowsPl(unit, days) }, unit, surface);
}

/** The deposits reconciliation page in `unit`, held across a unit switch, in its own unit. */
export function useHeldFlowsDepositsReconciliation(surface: string, unit: DisplayUnit) {
  return useHeldUnitQuery(
    { queryKey: queryKeys.flowsDepositsReconciliation(unit), queryFn: () => api.flowsDepositsReconciliation(unit) },
    unit,
    surface
  );
}

export function useRealEstateExpenses() {
  return useQuery({
    queryKey: queryKeys.flowsRealEstateExpenses(),
    queryFn: () => api.flowsRealEstateExpenses(),
  });
}

export function useRealEstateLinkCandidates(expenseEntryId: number | null, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.realEstateLinkCandidates(expenseEntryId ?? 0),
    queryFn: () => api.realEstateExpenseLinkCandidates(expenseEntryId!),
    enabled: enabled && expenseEntryId != null && expenseEntryId > 0,
  });
}

export function useRealEstateUnlinkedPurchases(
  params: { q?: string; place?: string; kind?: string; category?: string },
  enabled: boolean
) {
  const normalized: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) {
    if (v) normalized[k] = v;
  }
  return useQuery({
    queryKey: queryKeys.realEstateUnlinkedPurchases(normalized),
    queryFn: () => api.realEstateUnlinkedPurchases(normalized),
    enabled,
  });
}

/** The places a rent credit can name, and the place each rent line names (the income page's type select). */
export function useIncomeRentPlaces() {
  return useQuery({
    queryKey: queryKeys.incomeRentPlaces(),
    queryFn: () => api.incomeRentPlaces(),
  });
}

export function useRealEstatePropertyAccounts(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.realEstatePropertyAccounts(),
    queryFn: () => api.realEstatePropertyAccounts(),
    enabled,
  });
}

/**
 * One expense-lines list (a facturación, a list, a big group), each line's `converted` in `unit`, as
 * the list shows it: held across a unit or page change (dimmed, in its own `unit`); a list never
 * shows another list's rows while it loads, and one already cached shows at once.
 */
export function useHeldFlowsExpenseLines(
  surface: string,
  unit: DisplayUnit,
  selector: import("../types").FlowsExpenseLinesSelector | null,
  enabled = true,
  page?: { page: number; pageSize: number }
) {
  return useHeldUnitQuery(
    {
      queryKey: queryKeys.flowsExpenseLines(unit, selector, page),
      queryFn: () => api.flowsExpenseLines(unit, selector!, page),
      enabled: enabled && selector != null,
    },
    unit,
    surface
  );
}

/** The Expenses page's catalogs and summaries (categories, big groups, additional cards), held across a unit switch. */
export function useHeldFlowsExpensesSummary(surface: string, unit: DisplayUnit) {
  return useHeldUnitQuery(
    { queryKey: queryKeys.flowsExpensesSummary(unit), queryFn: () => api.flowsExpensesSummary(unit) },
    unit,
    surface
  );
}

/** The purchases a card credit may refund, fetched while its picker is open; held across a unit switch. */
export function useHeldCardRefundCandidates(surface: string, unit: DisplayUnit, accountId: number, lineId: number, enabled: boolean) {
  return useHeldUnitQuery(
    {
      queryKey: queryKeys.cardRefundCandidates(unit, accountId, lineId),
      queryFn: () => api.cardRefundCandidates(unit, accountId, lineId),
      enabled,
    },
    unit,
    surface
  );
}

/** The financing manager's pickers: financed cards with their facturaciones, and the plans; held across a unit switch. */
export function useHeldFlowsExpensesFinancingCandidates(surface: string, unit: DisplayUnit, enabled: boolean) {
  return useHeldUnitQuery(
    {
      queryKey: queryKeys.flowsExpensesFinancingCandidates(unit),
      queryFn: () => api.flowsExpensesFinancingCandidates(unit),
      enabled,
    },
    unit,
    surface
  );
}

/**
 * The Expenses page by spending day: chart, day strip, the months' calendar days and matrix cells.
 * Held across a unit or any selector change (mode, level, range, groups, pre-tax), in its own unit.
 */
export function useHeldFlowsExpensesSpent(surface: string, params: ExpensesSpentParams, enabled = true) {
  return useHeldUnitQuery(
    { queryKey: queryKeys.flowsExpensesSpent(params), queryFn: () => api.flowsExpensesSpent(params), enabled },
    params.unit,
    surface
  );
}

/**
 * The lines of one month (a day of it, a category) by spending day, grouped by day; held across a
 * unit, month, day or category change, in its own unit.
 */
export function useHeldFlowsExpensesSpentLines(
  surface: string,
  params: ExpensesSpentParams,
  sel: { month: string; day: string | null; category: string | null },
  enabled = true
) {
  return useHeldUnitQuery(
    {
      queryKey: queryKeys.flowsExpensesSpentLines(params, sel.month, sel.day, sel.category),
      queryFn: () => api.flowsExpensesSpentLines(params, sel),
      enabled,
    },
    params.unit,
    surface
  );
}

/**
 * The flows overview (income, expenses, deposits, P/L, net by month, by day when `days` is given,
 * this month / year), as a surface shows it: held across a unit, installment-mode or window change,
 * in its own unit.
 */
export function useHeldFlowsOverview(surface: string, unit: DisplayUnit, installmentMode: "split" | "total", days?: number) {
  const queryKey = queryKeys.flowsOverview(unit, installmentMode, days);
  return useHeldUnitQuery(
    {
      queryKey,
      queryFn: () => api.flowsOverview(unit, installmentMode, days),
      ...DISPLAY_UNIT_QUERY_BEHAVIOR,
    },
    unit,
    surface
  );
}

export function useCcFacturadoFinancingLinks() {
  return useQuery({
    queryKey: queryKeys.ccFacturadoFinancingLinks(),
    queryFn: () => api.ccFacturadoFinancingLinks(),
  });
}

export function useCreditCardConfig(accountId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: queryKeys.creditCardConfig(accountId ?? ""),
    queryFn: () => api.creditCardConfig(accountId!),
    enabled: enabled && Boolean(accountId),
  });
}

export function usePatchCreditCardConfigMutation(accountId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: import("../types").CreditCardConfigPatchBody) =>
      api.patchCreditCardConfig(accountId, body),
    onSuccess: async (result) => {
      queryClient.setQueryData(queryKeys.creditCardConfig(accountId), result);
    },
  });
}

export {
  useAssignCcExpenseLineCategory,
  useDeleteCcPurchaseMutation,
  useDeleteCcStatementLineMutation,
  useAnnulCcPurchaseMutation,
  useUndoCcAnnulledPurchaseMutation,
  useMakeStatementLineInstallmentMutation,
  useUpdateCcPurchaseCuotasMutation,
  useAccountImportMutation,
  usePatchCcExpenseLineCategoryMutation,
  usePatchCcExpensePurchaseNoteMutation,
  usePutCcExpensePurchaseBigGroupMutation,
  usePostVendorBranchChoiceMutation,
  useCreateCcExpenseBigGroupMutation,
  useRenameCcExpenseBigGroupMutation,
  useDeleteCcExpenseBigGroupMutation,
  useLinkRealEstateExpenseMutation,
  useUnmatchRealEstateExpenseMutation,
  useUpsertCcFacturadoFinancingLinkMutation,
  useDeleteCcFacturadoFinancingLinkMutation,
  useSaveExpenseLinePiecesMutation,
  useSaveManualExpenseMutation,
  useDeleteManualExpenseMutation,
  useLinkCardRefundMutation,
  useUnlinkCardRefundMutation,
} from "./mutations";

export function usePortfolioGroupCcLedger(slug: string | undefined, enabled = true) {
  return useQuery({
    queryKey: queryKeys.portfolioGroupCcLedger(slug ?? ""),
    queryFn: () => api.portfolioGroupCcLedger(slug!),
    enabled: enabled && Boolean(slug),
    ...DISPLAY_UNIT_QUERY_BEHAVIOR,
  });
}

/** The credit-card group page's lanes and «Upcoming payments by month» (`ccGroupLanes.ts`). */
export function usePortfolioGroupCcLanes(slug: string | undefined, enabled = true) {
  return useQuery({
    queryKey: queryKeys.portfolioGroupCcLanes(slug ?? ""),
    queryFn: () => api.portfolioGroupCcLanes(slug!),
    enabled: enabled && Boolean(slug),
    ...DISPLAY_UNIT_QUERY_BEHAVIOR,
  });
}

function mortgageGroupGlanceOptions(slug: string | undefined, unit: DisplayUnit) {
  const queryKey = queryKeys.mortgageGroupGlance(slug ?? "", unit);
  return {
    queryKey,
    queryFn: () => api.mortgageGroupGlance(slug!, unit),
    enabled: Boolean(slug),
    ...DISPLAY_UNIT_QUERY_BEHAVIOR,
  };
}

/** The mortgage group page (`mortgageGroupGlance.ts`), held across a unit switch, in its own unit. */
export function useHeldMortgageGroupGlance(surface: string, slug: string | undefined, unit: DisplayUnit) {
  return useHeldUnitQuery(mortgageGroupGlanceOptions(slug, unit), unit, surface);
}

function realEstateGroupGlanceOptions(slug: string | undefined, unit: DisplayUnit) {
  const queryKey = queryKeys.realEstateGroupGlance(slug ?? "", unit);
  return {
    queryKey,
    queryFn: () => api.realEstateGroupGlance(slug!, unit),
    enabled: Boolean(slug),
    ...DISPLAY_UNIT_QUERY_BEHAVIOR,
  };
}

/** The real-estate group page (`realEstateGroupGlance.ts`), held across a unit switch, in its own unit. */
export function useHeldRealEstateGroupGlance(surface: string, slug: string | undefined, unit: DisplayUnit) {
  return useHeldUnitQuery(realEstateGroupGlanceOptions(slug, unit), unit, surface);
}

function liabilitiesGlanceOptions(slug: string | undefined, unit: DisplayUnit) {
  const queryKey = queryKeys.liabilitiesGlance(slug ?? "", unit);
  return {
    queryKey,
    queryFn: () => api.liabilitiesGlance(slug!, unit),
    enabled: Boolean(slug),
    ...DISPLAY_UNIT_QUERY_BEHAVIOR,
  };
}

/** The Liabilities page's head and upcoming payments (`liabilitiesGlance.ts`), held across a unit switch. */
export function useHeldLiabilitiesGlance(surface: string, slug: string | undefined, unit: DisplayUnit) {
  return useHeldUnitQuery(liabilitiesGlanceOptions(slug, unit), unit, surface);
}

function accountDetailBundleOptions(id: string | undefined, unit: DisplayUnit, chartGranularity: "monthly" | "daily") {
  const queryKey = queryKeys.accountDetail(id ?? "", unit, chartGranularity);
  return {
    queryKey,
    queryFn: () => api.accountDetailBundle(id!, unit, { granularity: chartGranularity }),
    enabled: Boolean(id),
    ...DISPLAY_UNIT_QUERY_BEHAVIOR,
  };
}

/** An account page's bundle as the page shows it: held across a unit switch, in its own unit. */
export function useHeldAccountDetailBundle(surface: string, id: string | undefined, unit: DisplayUnit, chartGranularity: "monthly" | "daily") {
  return useHeldUnitQuery(accountDetailBundleOptions(id, unit, chartGranularity), unit, surface);
}

export type FlowsQueryFilters = {
  page: number;
  pageSize: number;
  year?: string;
  type?: string;
  account_id?: number;
  bucket?: string;
  q?: string;
  personal_only?: boolean;
  date_from?: string;
  date_to?: string;
  amount_min?: number;
  amount_max?: number;
  amount_exact?: number;
  /** Currency the amount filters compare against (server default: clp). */
  amount_currency?: string;
  /** Group flows only: leave out the checking movements the Expenses page counts as spending. */
  exclude_spending?: boolean;
};

function serializeFlowFilters(f: FlowsQueryFilters): string {
  return JSON.stringify({
    p: f.page,
    ps: f.pageSize,
    y: f.year ?? "",
    t: f.type ?? "",
    a: f.account_id ?? "",
    b: f.bucket ?? "",
    q: f.q ?? "",
    po: f.personal_only ?? false,
    df: f.date_from ?? "",
    dt: f.date_to ?? "",
    mn: f.amount_min ?? "",
    mx: f.amount_max ?? "",
    ex: f.amount_exact ?? "",
    ac: f.amount_currency ?? "",
    xs: f.exclude_spending ?? false,
  });
}

export function useGroupFlows(slug: string, filters: FlowsQueryFilters, enabled = true) {
  const filtersKey = useMemo(() => serializeFlowFilters(filters), [filters]);
  return useQuery({
    queryKey: queryKeys.groupFlows(slug, filtersKey),
    queryFn: () =>
      api.groupFlows(slug, {
        page: filters.page,
        pageSize: filters.pageSize,
        year: filters.year,
        type: filters.type,
        account_id: filters.account_id,
        bucket: filters.bucket,
        q: filters.q,
        date_from: filters.date_from,
        date_to: filters.date_to,
        amount_min: filters.amount_min,
        amount_max: filters.amount_max,
        amount_exact: filters.amount_exact,
        amount_currency: filters.amount_currency,
        exclude_spending: filters.exclude_spending,
      }),
    enabled: enabled && Boolean(slug),
    ...DISPLAY_UNIT_QUERY_BEHAVIOR,
    placeholderData: sameEntityPlaceholder(queryKeys.groupFlows(slug, filtersKey)),
  });
}

function fetchAccountFlows(id: string, filters: FlowsQueryFilters) {
  return api.accountFlows(id, {
    page: filters.page,
    pageSize: filters.pageSize,
    year: filters.year,
    type: filters.type,
    q: filters.q,
    personal_only: filters.personal_only,
    date_from: filters.date_from,
    date_to: filters.date_to,
    amount_min: filters.amount_min,
    amount_max: filters.amount_max,
    amount_exact: filters.amount_exact,
    amount_currency: filters.amount_currency,
  });
}

/**
 * One account's flows rows. The page's panel holds the previous page / filter's rows while
 * the next load (a filter change on one list). The cartola month modal holds nothing: a
 * month is its own list, and a month not in the cache yet shows its empty frame, never
 * another month's rows (a month already loaded comes straight from the cache).
 */
export function useAccountFlows(
  id: string | undefined,
  filters: FlowsQueryFilters,
  enabled = true,
  scope: AccountFlowsScope = "panel"
) {
  const filtersKey = useMemo(() => serializeFlowFilters(filters), [filters]);
  const queryKey = queryKeys.accountFlows(id ?? "", scope, filtersKey);
  return useQuery({
    queryKey,
    queryFn: () => fetchAccountFlows(id!, filters),
    enabled: enabled && Boolean(id),
    ...DISPLAY_UNIT_QUERY_BEHAVIOR,
    placeholderData: scope === "panel" ? sameEntityPlaceholder(queryKey) : undefined,
  });
}

export type CheckingStatementFilters = {
  kind?: import("../types").CheckingStatementKindFilter;
  q?: string;
  hideOwn?: boolean;
};

/** A checking page's statement, newest months first; `fetchNextPage` reads the next older months. */
export function useCheckingStatement(accountId: number, filters: CheckingStatementFilters, enabled = true) {
  const filtersKey = JSON.stringify([filters.kind ?? "", filters.q ?? "", filters.hideOwn === true]);
  const queryKey = queryKeys.checkingStatement(String(accountId), filtersKey);
  return useInfiniteQuery({
    queryKey,
    queryFn: ({ pageParam }) => api.checkingStatement(accountId, { ...filters, before: pageParam ?? undefined }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.next_before,
    enabled: enabled && accountId > 0,
    staleTime: DISPLAY_UNIT_STALE_MS,
    placeholderData: sameEntityPlaceholder(queryKey),
  });
}

export function useMovementMirrorCandidates() {
  return useQuery({
    queryKey: queryKeys.movementMirrorCandidates(),
    queryFn: () => api.movementMirrorCandidates(),
  });
}


/** The projections in `unit` for these assumptions, held across a unit or assumptions change, in its own unit. */
export function useHeldProjections(
  surface: string,
  unit: DisplayUnit,
  overrides: import("../projectionsOverrides").ProjectionOverrides
) {
  const overridesKey = useMemo(() => JSON.stringify(overrides), [overrides]);
  return useHeldUnitQuery(
    { queryKey: queryKeys.projections(unit, overridesKey), queryFn: () => api.projections(unit, overrides) },
    unit,
    surface
  );
}

export function useTaxReturn(taxYear: number | null) {
  return useQuery({
    queryKey: queryKeys.taxReturn(taxYear),
    queryFn: () => api.taxReturn(taxYear),
    placeholderData: (prev) => prev,
  });
}

/** The declared tax residency periods (Settings panel). */
export function useTaxResidency() {
  return useQuery({ queryKey: queryKeys.taxResidency(), queryFn: () => api.taxResidency() });
}

/** The 1040 of a US tax year; idle while `taxYear` is null (the año tributario has no US return). */
export function useUsTaxReturn(taxYear: number | null) {
  return useQuery({
    queryKey: queryKeys.usTaxReturn(taxYear),
    queryFn: () => api.usTaxReturn(taxYear!),
    enabled: taxYear != null,
    placeholderData: (prev) => prev,
  });
}

export function useBenchmarks() {
  return useQuery({
    queryKey: queryKeys.benchmarks(),
    queryFn: () => api.benchmarks(),
    staleTime: Infinity,
  });
}

type PrepaymentsScope = { accountId: number } | { portfolioGroup: string };

function deptoPrepaymentsOptions(scope: PrepaymentsScope, benchmark: string, unit: DisplayUnit, enabled: boolean) {
  return {
    queryKey:
      "accountId" in scope
        ? queryKeys.deptoPrepayments(scope.accountId, benchmark, unit)
        : queryKeys.mortgageGroupPrepayments(scope.portfolioGroup, benchmark, unit),
    queryFn: () =>
      "accountId" in scope
        ? api.deptoPrepayments(scope.accountId, benchmark, unit)
        : api.mortgageGroupPrepayments(scope.portfolioGroup, benchmark, unit),
    enabled,
    staleTime: DISPLAY_UNIT_STALE_MS,
    refetchInterval: DISPLAY_UNIT_STALE_MS,
  };
}

/**
 * A mortgage payments list's prepaid-vs-invested column for `benchmark`: one loan's, or the
 * mortgage group's merged list. Held across a unit switch, in its own unit.
 */
export function useHeldDeptoPrepayments(
  surface: string,
  scope: PrepaymentsScope,
  benchmark: string,
  unit: DisplayUnit,
  enabled: boolean
) {
  return useHeldUnitQuery(deptoPrepaymentsOptions(scope, benchmark, unit, enabled), unit, surface);
}

function benchmarkComparisonOptions(scope: PrepaymentsScope, benchmark: string, unit: DisplayUnit, enabled: boolean) {
  const scopeKey = "accountId" in scope ? `a:${scope.accountId}` : `g:${scope.portfolioGroup}`;
  return {
    queryKey: queryKeys.benchmarkComparison(scopeKey, benchmark, unit),
    queryFn: () => api.benchmarkComparison(scope, benchmark, unit),
    enabled,
    staleTime: DISPLAY_UNIT_STALE_MS,
    refetchInterval: DISPLAY_UNIT_STALE_MS,
  };
}

/**
 * The Rentabilidad comparison row for an account or a group page, requested in the unit of the
 * list it sits beside (`unit`) and held across a change of it, in its own unit. While the list
 * shows another unit than the display unit (a switch in flight), the display unit's comparison is
 * fetched too (`warmUnit`), so it is in when the list flips.
 */
export function useHeldBenchmarkComparison(
  surface: string,
  scope: PrepaymentsScope,
  benchmark: string,
  unit: DisplayUnit,
  warmUnit: DisplayUnit,
  enabled: boolean
) {
  const queryClient = useQueryClient();
  const scopeKey = "accountId" in scope ? `a:${scope.accountId}` : `g:${scope.portfolioGroup}`;
  useEffect(() => {
    if (!enabled || warmUnit === unit) return;
    // Fetched afresh: a cached copy may be older than the comparison on screen (`heldUnitPayload.ts`).
    void queryClient.prefetchQuery({ ...benchmarkComparisonOptions(scope, benchmark, warmUnit, true), staleTime: 0 });
    // `scopeKey` stands for `scope`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryClient, scopeKey, benchmark, unit, warmUnit, enabled]);
  return useHeldUnitQuery(benchmarkComparisonOptions(scope, benchmark, unit, enabled), unit, surface);
}

/** The wealth percentile page in `unit`, held across a unit switch, in its own unit. */
export function useHeldWealthPercentile(surface: string, unit: DisplayUnit) {
  return useHeldUnitQuery(
    { queryKey: queryKeys.wealthPercentile(unit), queryFn: () => api.wealthPercentile(unit) },
    unit,
    surface
  );
}
