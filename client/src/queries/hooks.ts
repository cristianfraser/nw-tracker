import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { api } from "../api";
import {
  dashPickForNavStrip,
  fetchAccountsByPortfolioGroup,
  fetchDashboardBundle,
  fetchDashboardNavContext,
  fetchDashboardNavSnapshot,
  fetchPortfolioGroupBundle,
  type DashboardNavContext,
} from "./fetchers";
import {
  hasDashboardNavSnapshotCache,
  navSnapshotCoversNavTree,
  readDashboardNavSnapshotCache,
  writeDashboardNavSnapshotCache,
} from "./dashboardNavSnapshotCache";
import { DISPLAY_UNIT_STALE_MS, displayUnitQueryBehaviorFor } from "./displayUnitQueries";
import { otherDisplayUnit, queryKeys, type DisplayUnit } from "./keys";
import { buildGroupPageShellFromNav } from "../placeholders/groupPageShellFromNav";
import { hasGroupPageShellCache, readGroupPageShellCache } from "./groupPageShellCache";
import { readSidebarNavCache, writeSidebarNavCache } from "./sidebarNavCache";
import type { NavTreeNodeDto } from "../types";

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

export function useDashboardBundle(unit: DisplayUnit, enabled = true) {
  return useQuery({
    queryKey: queryKeys.dashboard(unit),
    queryFn: () => fetchDashboardBundle(unit),
    enabled,
    ...displayUnitQueryBehaviorFor(queryKeys.dashboard(unit), 1),
  });
}

/** Daily net-worth series for the day period view (fetched only while the D toggle is active). */
export function useDashboardOverviewDaily(unit: DisplayUnit, days: number, enabled = true) {
  return useQuery({
    queryKey: queryKeys.dashboardOverviewDaily(unit, days),
    queryFn: () => api.dashboardOverviewDaily(unit, days),
    enabled,
    ...displayUnitQueryBehaviorFor(queryKeys.dashboardOverviewDaily(unit, days), 1),
  });
}

/** Home P/L + deposits combo in day mode (retirement + brokerage, levels anchored server-side). */
export function useInversionesPerfDaily(unit: DisplayUnit, days: number, enabled = true) {
  return useQuery({
    queryKey: queryKeys.inversionesPerfDaily(unit, days),
    queryFn: () => api.inversionesPerfDaily(unit, days),
    enabled,
    ...displayUnitQueryBehaviorFor(queryKeys.inversionesPerfDaily(unit, days), 1),
  });
}

/** Daily series for one group page or account (day period view: chart + detalle por día). */
export function useDailySeries(
  scope: { portfolioGroup?: string; accountId?: number },
  unit: DisplayUnit,
  days: number,
  enabled = true,
  /** Ask for the day-mode P/L levels (`perf_levels`) the P/L combos pick. */
  opts?: { perfLevels?: boolean }
) {
  const scopeKey = scope.portfolioGroup
    ? `pg:${scope.portfolioGroup}`
    : scope.accountId != null
      ? `account:${scope.accountId}`
      : "";
  const perfLevels = opts?.perfLevels === true;
  const key = queryKeys.dailySeries(scopeKey, perfLevels ? "perf" : "base", unit, days);
  return useQuery({
    queryKey: key,
    queryFn: () => api.dailySeries(unit, scope, days, { perfLevels }),
    enabled: enabled && scopeKey !== "",
    ...displayUnitQueryBehaviorFor(key, 3),
  });
}

export function useDashboardNavContext(unit: DisplayUnit, enabled = true) {
  return useQuery({
    queryKey: queryKeys.dashboardNav(unit),
    queryFn: async () => {
      const ctx = await fetchDashboardNavContext(unit);
      return ctx;
    },
    enabled,
    // A unit change holds nothing: the pages fall back to the unit's own nav snapshot cache, never a converted context.
    ...displayUnitQueryBehaviorFor(queryKeys.dashboardNav(unit), 2),
  });
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
    initialDataUpdatedAt: cachedStrip ? Date.now() : undefined,
    // With a cached strip this query never refetches; freshness relies on DashboardPage
    // re-writing the cache from the live page bundle (writeDashboardNavSnapshotCache there).
    enabled: enabled && !cachedStrip,
    // Keyed on the unit: a unit change holds nothing (a CLP snapshot has no USD fields; the pages
    // hold the previous unit's strip themselves, see useHeldNavStrip).
    ...displayUnitQueryBehaviorFor(queryKeys.dashboardNavSnapshot(unit), 2),
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

/** What a nav strip renders while the page holds the previous unit: cards in THAT unit. */
export type HeldNavStrip = {
  dash: ReturnType<typeof dashPickForNavStrip>;
  overviewPoints: DashboardNavContext["overviewPoints"];
  showUsd: boolean;
};

/**
 * The previous unit's nav strip while a unit switch holds the page (`holding`): its live nav
 * context when react-query still has it, else its stored snapshot — shown in ITS unit, dimmed,
 * never converted; null when neither is on hand. Read only: neither query is enabled here, so
 * nothing is fetched for a unit the user left.
 */
export function useHeldNavStrip(unit: DisplayUnit, holding: boolean): HeldNavStrip | null {
  const other = otherDisplayUnit(unit);
  const { data: navCtx } = useDashboardNavContext(other, false);
  const { data: navSnapshot } = useDashboardNavSnapshot(other, false);
  return useMemo(() => {
    if (!holding) return null;
    if (navCtx) {
      return { dash: dashPickForNavStrip(navCtx), overviewPoints: navCtx.overviewPoints, showUsd: other === "usd" };
    }
    if (!navSnapshot) return null;
    return {
      dash: dashPickForNavStrip({
        accounts: navSnapshot.accounts,
        liabilities_breakdown: navSnapshot.liabilities_breakdown,
        dashboard_layout: navSnapshot.dashboard_layout,
        nw_bucket_totals: navSnapshot.nw_bucket_totals,
        card_metrics_by_slug: navSnapshot.card_metrics_by_slug,
        overviewPoints: [],
      }),
      overviewPoints: [],
      showUsd: other === "usd",
    };
  }, [holding, navCtx, navSnapshot, other]);
}

export function useGroupConsolidatedTables(
  portfolioGroup: string,
  unit: DisplayUnit,
  enabled: boolean
) {
  return useQuery({
    queryKey: queryKeys.groupConsolidatedTables(portfolioGroup, undefined, unit),
    queryFn: () => api.groupConsolidatedTables(portfolioGroup, unit),
    enabled: enabled && Boolean(portfolioGroup),
    ...displayUnitQueryBehaviorFor(queryKeys.groupConsolidatedTables(portfolioGroup, undefined, unit), 2),
  });
}

/** The Rentabilidad table alone (dashboard net_worth, whose detalle table is server-paginated). */
export function useGroupPeriodReturns(portfolioGroup: string, unit: DisplayUnit, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.groupPeriodReturns(portfolioGroup, unit),
    queryFn: () => api.groupPeriodReturns(portfolioGroup, unit),
    enabled: enabled && Boolean(portfolioGroup),
    ...displayUnitQueryBehaviorFor(queryKeys.groupPeriodReturns(portfolioGroup, unit), 2),
  });
}

/** Home «Últimos gastos»: the newest expense lines across every source. */
export function useLatestExpenses(unit: DisplayUnit, limit: number) {
  return useQuery({
    queryKey: queryKeys.latestExpenses(unit, limit),
    queryFn: () => api.latestExpenses(unit, limit),
    ...displayUnitQueryBehaviorFor(queryKeys.latestExpenses(unit, limit), 3),
  });
}

/** One server page of the consolidated detalle table (dashboard net_worth). */
export function useGroupConsolidatedMonthlyPage(
  portfolioGroup: string,
  unit: DisplayUnit,
  period: "month" | "year",
  page: number,
  pageSize: number,
  enabled: boolean
) {
  return useQuery({
    queryKey: queryKeys.groupConsolidatedMonthlyPage(portfolioGroup, unit, period, page),
    queryFn: () => api.groupConsolidatedMonthly(portfolioGroup, unit, { page, pageSize, period }),
    enabled: enabled && Boolean(portfolioGroup),
    ...displayUnitQueryBehaviorFor(queryKeys.groupConsolidatedMonthlyPage(portfolioGroup, unit, period, page), 2),
  });
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
    ...displayUnitQueryBehaviorFor(queryKeys.accountsByPortfolioGroup(portfolioGroup, unit), 3),
    staleTime: DISPLAY_UNIT_STALE_MS,
    gcTime: DISPLAY_UNIT_STALE_MS,
  });
}

export function usePortfolioGroupBundle(opts: {
  portfolio_group: string;
  unit: DisplayUnit;
  enabled?: boolean;
}) {
  const { portfolio_group, unit, enabled = true } = opts;
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: queryKeys.portfolioGroup(portfolio_group, undefined, unit),
    queryFn: () => fetchPortfolioGroupBundle({ portfolio_group, unit }, queryClient),
    enabled: enabled && Boolean(portfolio_group),
    ...displayUnitQueryBehaviorFor(queryKeys.portfolioGroup(portfolio_group, undefined, unit), 2),
  });
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
      return buildGroupPageShellFromNav(navNode, unit);
    },
    initialData: () =>
      cachedShell ? readGroupPageShellCache(portfolioGroup, unit) : undefined,
    initialDataUpdatedAt: cachedShell ? Date.now() : undefined,
    enabled: enabled && Boolean(portfolioGroup && navNode) && !cachedShell,
    ...displayUnitQueryBehaviorFor(queryKeys.groupPageShell(portfolioGroup, unit), 2),
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

export function useRatesInstruments() {
  return useQuery({
    queryKey: queryKeys.ratesInstruments(),
    queryFn: () => api.ratesInstruments(),
    staleTime: 300_000,
  });
}

const MARKET_TICKER_MS = 60_000;

/** Marquee snapshot in the display unit (values convert server-side; the key carries the unit). */
export function useMarketTicker(unit: DisplayUnit) {
  return useQuery({
    queryKey: queryKeys.marketTicker(unit),
    queryFn: () => api.marketTicker(unit),
    staleTime: MARKET_TICKER_MS,
    refetchInterval: MARKET_TICKER_MS,
    placeholderData: keepPreviousData,
  });
}

export function useWatchlist(unit: DisplayUnit) {
  return useQuery({
    queryKey: queryKeys.watchlist(unit),
    queryFn: () => api.watchlist(unit),
    staleTime: MARKET_TICKER_MS,
    refetchInterval: MARKET_TICKER_MS,
    placeholderData: keepPreviousData,
  });
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
  queryClient.invalidateQueries({ queryKey: queryKeys.watchlistAll() });
  queryClient.invalidateQueries({ queryKey: queryKeys.marketTickerAll() });
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

export function useMarketSeries() {
  return useQuery({
    queryKey: queryKeys.marketSeries(),
    queryFn: () => api.marketSeries(),
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
      void queryClient.invalidateQueries({ queryKey: queryKeys.jobQueue() });
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
      void queryClient.invalidateQueries({ queryKey: queryKeys.ingestRunsStatus() });
    },
  });
}

export function useImportSyncDocumentCoverage() {
  return useQuery({
    queryKey: queryKeys.importSyncDocumentCoverage(),
    queryFn: () => api.importSyncDocumentCoverage(),
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
      void queryClient.invalidateQueries({ queryKey: queryKeys.genericUniqueMerchants() });
    },
  });
}

export function useUpdateGenericUniqueMerchantMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, merchant }: { id: number; merchant: string }) =>
      api.updateGenericUniqueMerchant(id, merchant),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.genericUniqueMerchants() });
    },
  });
}

export function useDeleteGenericUniqueMerchantMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.deleteGenericUniqueMerchant(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.genericUniqueMerchants() });
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
      void queryClient.invalidateQueries({ queryKey: queryKeys.messagesUnread() });
      window.dispatchEvent(new Event("nw-messages-read"));
    },
  });
}

/** The income page payload with its aggregates in `unit` (never held across units). */
export function useIncome(unit: DisplayUnit) {
  return useQuery({
    queryKey: queryKeys.income(unit),
    queryFn: () => api.income(unit),
  });
}

export function useFlowsDeposits() {
  return useQuery({
    queryKey: queryKeys.flowsDeposits(),
    queryFn: () => api.flowsDeposits(),
  });
}

export function useFlowsPl(days?: number) {
  return useQuery({
    queryKey: queryKeys.flowsPl(days),
    queryFn: () => api.flowsPl(days),
    placeholderData: keepPreviousData,
  });
}

export function useFlowsDepositsReconciliation() {
  return useQuery({
    queryKey: queryKeys.flowsDepositsReconciliation(),
    queryFn: () => api.flowsDepositsReconciliation(),
  });
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

export function useRealEstatePropertyAccounts(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.realEstatePropertyAccounts(),
    queryFn: () => api.realEstatePropertyAccounts(),
    enabled,
  });
}

export function useFlowsExpenses() {
  return useQuery({
    queryKey: queryKeys.flowsExpenses(),
    queryFn: () => api.flowsExpenses(),
  });
}

/** Gastos by month / category for every installment mode × category level; the page picks one. */
export function useFlowsExpensesGastos(
  unit: DisplayUnit,
  excludedBigGroups: readonly string[],
  enabled = true
) {
  return useQuery({
    queryKey: queryKeys.flowsExpensesGastos(unit, excludedBigGroups),
    queryFn: () => api.flowsExpensesGastos(unit, excludedBigGroups),
    placeholderData: keepPreviousData,
    enabled,
  });
}

/**
 * The flows overview (income, expenses, deposits, P/L, net by month, by day when `days` is given,
 * this month / year). Held across an installment-mode or window change, never across units.
 */
export function useFlowsOverview(unit: DisplayUnit, installmentMode: "split" | "total", days?: number) {
  const queryKey = queryKeys.flowsOverview(unit, installmentMode, days);
  return useQuery({
    queryKey,
    queryFn: () => api.flowsOverview(unit, installmentMode, days),
    ...displayUnitQueryBehaviorFor(queryKey, 3),
  });
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
  useMakeStatementLineInstallmentMutation,
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
} from "./mutations";

export function useAccountMonthlyPerformance(id: string | undefined, unit: DisplayUnit) {
  return useQuery({
    queryKey: queryKeys.accountMonthlyPerformance(id ?? "", unit),
    queryFn: () => api.accountMonthlyPerformance(id!, unit),
    enabled: Boolean(id),
    ...displayUnitQueryBehaviorFor(queryKeys.accountMonthlyPerformance(id ?? "", unit), 2),
  });
}

export function usePortfolioGroupCcLedger(slug: string | undefined, enabled = true) {
  return useQuery({
    queryKey: queryKeys.portfolioGroupCcLedger(slug ?? ""),
    queryFn: () => api.portfolioGroupCcLedger(slug!),
    enabled: enabled && Boolean(slug),
    ...displayUnitQueryBehaviorFor(queryKeys.portfolioGroupCcLedger(slug ?? ""), 2),
  });
}

export function usePortfolioGroupMortgageLedger(slug: string | undefined, enabled = true) {
  return useQuery({
    queryKey: queryKeys.portfolioGroupMortgageLedger(slug ?? ""),
    queryFn: () => api.portfolioGroupMortgageLedger(slug!),
    enabled: enabled && Boolean(slug),
    ...displayUnitQueryBehaviorFor(queryKeys.portfolioGroupMortgageLedger(slug ?? ""), 2),
  });
}


export function useAccountDetailBundle(
  id: string | undefined,
  unit: DisplayUnit,
  chartGranularity: "monthly" | "daily"
) {
  return useQuery({
    queryKey: queryKeys.accountDetail(id ?? "", unit, chartGranularity),
    queryFn: () => api.accountDetailBundle(id!, unit, { granularity: chartGranularity }),
    enabled: Boolean(id),
    ...displayUnitQueryBehaviorFor(queryKeys.accountDetail(id ?? "", unit, chartGranularity), 2),
  });
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
    ...displayUnitQueryBehaviorFor(queryKeys.groupFlows(slug, filtersKey), 2),
  });
}

export function useAccountFlows(id: string | undefined, filters: FlowsQueryFilters, enabled = true) {
  const filtersKey = useMemo(() => serializeFlowFilters(filters), [filters]);
  return useQuery({
    queryKey: queryKeys.accountFlows(id ?? "", filtersKey),
    queryFn: () =>
      api.accountFlows(id!, {
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
      }),
    enabled: enabled && Boolean(id),
    ...displayUnitQueryBehaviorFor(queryKeys.accountFlows(id ?? "", filtersKey), 2),
  });
}

export function useMovementMirrorCandidates() {
  return useQuery({
    queryKey: queryKeys.movementMirrorCandidates(),
    queryFn: () => api.movementMirrorCandidates(),
  });
}


export function useProjections(
  unit: "clp" | "usd",
  overrides: Partial<import("../types").ProjectionParams>
) {
  const overridesKey = useMemo(() => JSON.stringify(overrides), [overrides]);
  return useQuery({
    queryKey: queryKeys.projections(unit, overridesKey),
    queryFn: () => api.projections(unit, overrides),
    placeholderData: (prev) => prev,
  });
}

export function useTaxReturn(taxYear: number | null) {
  return useQuery({
    queryKey: queryKeys.taxReturn(taxYear),
    queryFn: () => api.taxReturn(taxYear),
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

/** The mortgage's payments above the minimum, prepaid vs invested in a benchmark. */
export function useMortgagePrepaymentComparison(
  accountId: number,
  benchmark: string,
  unit: DisplayUnit,
  enabled: boolean
) {
  return useQuery({
    queryKey: queryKeys.mortgagePrepaymentComparison(accountId, benchmark, unit),
    queryFn: () => api.mortgagePrepaymentComparison(accountId, benchmark, unit),
    enabled,
    staleTime: DISPLAY_UNIT_STALE_MS,
    refetchInterval: DISPLAY_UNIT_STALE_MS,
  });
}

/** The Rentabilidad comparison row for an account or a group page. */
export function useBenchmarkComparison(
  scope: { accountId: number } | { portfolioGroup: string },
  benchmark: string,
  unit: DisplayUnit,
  enabled: boolean
) {
  const scopeKey = "accountId" in scope ? `a:${scope.accountId}` : `g:${scope.portfolioGroup}`;
  return useQuery({
    queryKey: queryKeys.benchmarkComparison(scopeKey, benchmark, unit),
    queryFn: () => api.benchmarkComparison(scope, benchmark, unit),
    enabled,
    staleTime: DISPLAY_UNIT_STALE_MS,
    refetchInterval: DISPLAY_UNIT_STALE_MS,
  });
}

export function useWealthPercentile() {
  return useQuery({
    queryKey: queryKeys.wealthPercentile(),
    queryFn: () => api.wealthPercentile(),
  });
}
