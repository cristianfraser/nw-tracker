import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { api } from "../api";
import {
  fetchAccountsByPortfolioGroup,
  fetchDashboardBundle,
  fetchDashboardNavContext,
  fetchDashboardNavSnapshot,
  fetchPortfolioGroupBundle,
  type DashboardNavContext,
} from "./fetchers";
import {
  hasDashboardNavSnapshotCache,
  readDashboardNavSnapshotCache,
  writeDashboardNavSnapshotCache,
} from "./dashboardNavSnapshotCache";
import { readFxLatestCache } from "./fxLatestCache";
import { DISPLAY_UNIT_STALE_MS, displayUnitQueryBehavior } from "./displayUnitQueries";
import { queryKeys, type DisplayUnit } from "./keys";
import { buildGroupPageShellFromNav } from "../placeholders/groupPageShellFromNav";
import {
  perturbDashboardNavSnapshot,
  perturbGroupPageShell,
  synthesizeMissingUsdOnDashboardNavContext,
  synthesizeMissingUsdOnGroupPageShell,
  synthesizeMissingUsdOnNavSnapshot,
} from "../placeholders/perturbCachedAmount";
import { hasGroupPageShellCache, readGroupPageShellCache } from "./groupPageShellCache";
import { readSidebarNavCache, writeSidebarNavCache } from "./sidebarNavCache";
import type { GroupPageShell } from "./groupPageShell";
import type { NavTreeNodeDto } from "../types";

function prepareNavSnapshotForDisplay(
  unit: DisplayUnit,
  raw: import("../types").DashboardNavSnapshotResponse
) {
  const cachedFx = readFxLatestCache();
  const prepared = unit === "usd" ? synthesizeMissingUsdOnNavSnapshot(raw, cachedFx) : raw;
  if (unit === "usd") return prepared;
  return perturbDashboardNavSnapshot(prepared);
}

function readNavSnapshotCacheForUnit(unit: DisplayUnit) {
  const raw =
    readDashboardNavSnapshotCache(unit) ??
    (unit === "usd" ? readDashboardNavSnapshotCache("clp") : undefined);
  if (!raw) return undefined;
  return prepareNavSnapshotForDisplay(unit, raw);
}

function readGroupPageShellCacheForUnit(
  portfolioGroup: string,
  unit: DisplayUnit
): GroupPageShell | undefined {
  const cached = readGroupPageShellCache(portfolioGroup, unit);
  if (cached) return cached;
  if (unit !== "usd") return undefined;
  const clpShell = readGroupPageShellCache(portfolioGroup, "clp");
  if (!clpShell) return undefined;
  return synthesizeMissingUsdOnGroupPageShell(clpShell, readFxLatestCache());
}

export { hasDashboardNavSnapshotCache } from "./dashboardNavSnapshotCache";

export function useDashboardBundle(unit: DisplayUnit, enabled = true) {
  return useQuery({
    queryKey: queryKeys.dashboard(unit),
    queryFn: () => fetchDashboardBundle(unit),
    enabled,
    ...displayUnitQueryBehavior,
  });
}

/** Daily net-worth series for the day period view (fetched only while the D toggle is active). */
export function useDashboardOverviewDaily(unit: DisplayUnit, sessions: number, enabled = true) {
  return useQuery({
    queryKey: queryKeys.dashboardOverviewDaily(unit, sessions),
    queryFn: () => api.dashboardOverviewDaily(unit, sessions),
    enabled,
    ...displayUnitQueryBehavior,
  });
}

/** Daily series for one group page or account (day period view: chart + detalle por día). */
export function useDailySeries(
  scope: { portfolioGroup?: string; accountId?: number },
  unit: DisplayUnit,
  sessions: number,
  enabled = true
) {
  const scopeKey = scope.portfolioGroup
    ? `pg:${scope.portfolioGroup}`
    : scope.accountId != null
      ? `account:${scope.accountId}`
      : "";
  return useQuery({
    queryKey: queryKeys.dailySeries(scopeKey, unit, sessions),
    queryFn: () => api.dailySeries(unit, scope, sessions),
    enabled: enabled && scopeKey !== "",
    ...displayUnitQueryBehavior,
  });
}

/**
 * Held prior-unit data during a CLP→USD switch gets its USD fields synthesized (FX approximation),
 * memoized per source object so downstream `useMemo`s keep a stable identity across renders —
 * the placeholderData fn runs on every render while the new-unit fetch is in flight.
 */
const synthesizedNavCtxByPrev = new WeakMap<DashboardNavContext, DashboardNavContext>();

export function useDashboardNavContext(unit: DisplayUnit, enabled = true) {
  return useQuery({
    queryKey: queryKeys.dashboardNav(unit),
    queryFn: async () => {
      const ctx = await fetchDashboardNavContext(unit);
      return ctx;
    },
    enabled,
    ...displayUnitQueryBehavior,
    placeholderData: (prev: DashboardNavContext | undefined) => {
      if (!prev || unit !== "usd") return prev;
      let synthesized = synthesizedNavCtxByPrev.get(prev);
      if (!synthesized) {
        synthesized = synthesizeMissingUsdOnDashboardNavContext(prev, readFxLatestCache());
        synthesizedNavCtxByPrev.set(prev, synthesized);
      }
      return synthesized;
    },
  });
}

const DASHBOARD_NAV_SNAPSHOT_STALE_MS = 10 * 60_000;

/** Home card strip shape (accounts + layout); cached in localStorage between visits. */
export function useDashboardNavSnapshot(unit: DisplayUnit, enabled = true) {
  const cachedStrip = hasDashboardNavSnapshotCache(unit);
  return useQuery({
    queryKey: queryKeys.dashboardNavSnapshot(unit),
    queryFn: async () => {
      const snapshot = await fetchDashboardNavSnapshot(unit);
      writeDashboardNavSnapshotCache(unit, snapshot);
      return prepareNavSnapshotForDisplay(unit, snapshot);
    },
    initialData: () => (cachedStrip ? readNavSnapshotCacheForUnit(unit) : undefined),
    initialDataUpdatedAt: cachedStrip ? Date.now() : undefined,
    // With a cached strip this query never refetches; freshness relies on DashboardPage
    // re-writing the cache from the live page bundle (writeDashboardNavSnapshotCache there).
    enabled: enabled && !cachedStrip,
    ...displayUnitQueryBehavior,
    staleTime: DASHBOARD_NAV_SNAPSHOT_STALE_MS,
    gcTime: DASHBOARD_NAV_SNAPSHOT_STALE_MS,
  });
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
    ...displayUnitQueryBehavior,
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
    ...displayUnitQueryBehavior,
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
    ...displayUnitQueryBehavior,
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
    ...displayUnitQueryBehavior,
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
      const cached = readGroupPageShellCacheForUnit(portfolioGroup, unit);
      if (cached) return cached;
      if (!navNode) {
        throw new Error("useGroupPageShell: navNode required when cache is empty");
      }
      return buildGroupPageShellFromNav(navNode, unit);
    },
    initialData: () => {
      if (!cachedShell) return undefined;
      const raw = readGroupPageShellCacheForUnit(portfolioGroup, unit);
      if (!raw) return undefined;
      if (unit === "usd") return raw;
      return perturbGroupPageShell(raw);
    },
    initialDataUpdatedAt: cachedShell ? Date.now() : undefined,
    enabled: enabled && Boolean(portfolioGroup && navNode) && !cachedShell,
    ...displayUnitQueryBehavior,
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

export function usePortfolioTree() {
  return useQuery({
    queryKey: queryKeys.portfolioTree(),
    queryFn: () => api.portfolioTree(),
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

export function useMarketTicker() {
  return useQuery({
    queryKey: queryKeys.marketTicker(),
    queryFn: () => api.marketTicker(),
    staleTime: MARKET_TICKER_MS,
    refetchInterval: MARKET_TICKER_MS,
  });
}

export function useWatchlist() {
  return useQuery({
    queryKey: queryKeys.watchlist(),
    queryFn: () => api.watchlist(),
    staleTime: MARKET_TICKER_MS,
    refetchInterval: MARKET_TICKER_MS,
  });
}

export function usePatchWatchlistMarquee() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, show_in_marquee }: { id: number; show_in_marquee: number }) =>
      api.patchWatchlistRow(id, { show_in_marquee }),
    onMutate: async ({ id, show_in_marquee }) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.watchlist() });
      const prev = queryClient.getQueryData<import("../types").WatchlistResponse>(
        queryKeys.watchlist()
      );
      if (prev) {
        const patchRow = (rows: import("../types").WatchlistRow[]) =>
          rows.map((r) => (r.id === id ? { ...r, show_in_marquee } : r));
        queryClient.setQueryData(queryKeys.watchlist(), {
          app: patchRow(prev.app),
          manual: patchRow(prev.manual),
        });
      }
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(queryKeys.watchlist(), ctx.prev);
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.watchlist() });
      queryClient.invalidateQueries({ queryKey: queryKeys.marketTicker() });
    },
  });
}

export function useAddWatchlistTicker() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (ticker: string) => api.addWatchlistTicker(ticker),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.watchlist() });
      queryClient.invalidateQueries({ queryKey: queryKeys.marketTicker() });
    },
  });
}

export function useDeleteWatchlistRow() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.deleteWatchlistRow(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.watchlist() });
      queryClient.invalidateQueries({ queryKey: queryKeys.marketTicker() });
    },
  });
}

export function useMarketSeries() {
  return useQuery({
    queryKey: queryKeys.marketSeries(),
    queryFn: () => api.marketSeries(),
  });
}

export function useFxCoverage(enabled = true) {
  return useQuery({
    queryKey: queryKeys.fxCoverage(),
    queryFn: () => api.fxCoverage(),
    enabled,
    staleTime: 60_000,
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

export function useSyncStatus() {
  return useQuery({
    queryKey: queryKeys.syncStatus(),
    queryFn: () => api.syncStatus(),
    refetchInterval: 15_000,
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

export function useIncome() {
  return useQuery({
    queryKey: queryKeys.income(),
    queryFn: () => api.income(),
  });
}

export function useFlowsDeposits() {
  return useQuery({
    queryKey: queryKeys.flowsDeposits(),
    queryFn: () => api.flowsDeposits(),
  });
}

export function useFlowsPl() {
  return useQuery({
    queryKey: queryKeys.flowsPl(),
    queryFn: () => api.flowsPl(),
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

export function useFlowsCreditCardExpenses() {
  return useQuery({
    queryKey: queryKeys.flowsCreditCardExpenses(),
    queryFn: () => api.flowsCreditCardExpenses(),
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
  useMarkCcExpenseLineUniqueMutation,
  useDeleteCcPurchaseMutation,
  useDeleteCcStatementLineMutation,
  useMakeStatementLineInstallmentMutation,
  useAccountImportMutation,
  usePatchCcExpenseLineCategoryMutation,
  usePatchCcExpensePurchaseNoteMutation,
  usePutCcExpensePurchaseBigGroupMutation,
  useCreateCcExpenseBigGroupMutation,
  useRenameCcExpenseBigGroupMutation,
  useDeleteCcExpenseBigGroupMutation,
  useLinkRealEstateExpenseMutation,
  useUnmatchRealEstateExpenseMutation,
  useUpsertCcFacturadoFinancingLinkMutation,
  useDeleteCcFacturadoFinancingLinkMutation,
} from "./mutations";

export function useAccountMonthlyPerformance(id: string | undefined, unit: DisplayUnit) {
  return useQuery({
    queryKey: queryKeys.accountMonthlyPerformance(id ?? "", unit),
    queryFn: () => api.accountMonthlyPerformance(id!, unit),
    enabled: Boolean(id),
    ...displayUnitQueryBehavior,
  });
}

export function usePortfolioGroupCcLedger(
  slug: string | undefined,
  extraOffsets: Record<string, number> = {},
  enabled = true
) {
  const ccOffsetsKey = JSON.stringify(extraOffsets);
  return useQuery({
    queryKey: queryKeys.portfolioGroupCcLedger(slug ?? "", ccOffsetsKey),
    queryFn: () => api.portfolioGroupCcLedger(slug!, extraOffsets),
    enabled: enabled && Boolean(slug),
    ...displayUnitQueryBehavior,
  });
}

export function usePortfolioGroupMortgageLedger(slug: string | undefined, enabled = true) {
  return useQuery({
    queryKey: queryKeys.portfolioGroupMortgageLedger(slug ?? ""),
    queryFn: () => api.portfolioGroupMortgageLedger(slug!),
    enabled: enabled && Boolean(slug),
    ...displayUnitQueryBehavior,
  });
}

const SKIP_MONTHLY_PERF_SLUGS = new Set(["cuenta_corriente", "cuenta_vista", "cuenta_ahorro_vivienda"]);

export function useGroupAccountsMonthlyPerformance(
  accounts: readonly { id: number; name: string; category_slug: string }[],
  unit: DisplayUnit,
  enabled: boolean
) {
  const eligible = accounts.filter((a) => !SKIP_MONTHLY_PERF_SLUGS.has(a.category_slug));
  return useQueries({
    queries: eligible.map((a) => ({
      queryKey: queryKeys.accountMonthlyPerformance(String(a.id), unit),
      queryFn: () => api.accountMonthlyPerformance(a.id, unit),
      enabled,
      ...displayUnitQueryBehavior,
    })),
  });
}

export function useGroupAccountMovements(
  accounts: readonly { id: number; name: string; category_slug: string }[],
  enabled: boolean
) {
  return useQueries({
    queries: accounts.map((a) => ({
      queryKey: queryKeys.accountMovements(a.id),
      queryFn: async () => {
        const res = await api.accountMovements(a.id);
        return { account: a, movements: res.movements ?? [] };
      },
      enabled,
    })),
  });
}

export function useAccountDetailBundle(
  id: string | undefined,
  unit: DisplayUnit,
  chartGranularity: "monthly" | "daily",
  extraCcOffsets: Record<string, number>
) {
  const ccOffsetsKey = useMemo(() => JSON.stringify(extraCcOffsets), [extraCcOffsets]);

  return useQuery({
    queryKey: queryKeys.accountDetail(id ?? "", unit, chartGranularity, ccOffsetsKey),
    queryFn: () =>
      api.accountDetailBundle(id!, unit, {
        granularity: chartGranularity,
        extraOffsets: extraCcOffsets,
      }),
    enabled: Boolean(id),
    ...displayUnitQueryBehavior,
  });
}

export type FlowsQueryFilters = {
  page: number;
  pageSize: number;
  year?: string;
  type?: string;
  account_id?: number;
  category?: string;
  q?: string;
  personal_only?: boolean;
  date_from?: string;
  date_to?: string;
  amount_min?: number;
  amount_max?: number;
  amount_exact?: number;
};

function serializeFlowFilters(f: FlowsQueryFilters): string {
  return JSON.stringify({
    p: f.page,
    ps: f.pageSize,
    y: f.year ?? "",
    t: f.type ?? "",
    a: f.account_id ?? "",
    c: f.category ?? "",
    q: f.q ?? "",
    po: f.personal_only ?? false,
    df: f.date_from ?? "",
    dt: f.date_to ?? "",
    mn: f.amount_min ?? "",
    mx: f.amount_max ?? "",
    ex: f.amount_exact ?? "",
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
        category: filters.category,
        q: filters.q,
        date_from: filters.date_from,
        date_to: filters.date_to,
        amount_min: filters.amount_min,
        amount_max: filters.amount_max,
        amount_exact: filters.amount_exact,
      }),
    enabled: enabled && Boolean(slug),
    ...displayUnitQueryBehavior,
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
      }),
    enabled: enabled && Boolean(id),
    ...displayUnitQueryBehavior,
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

export function useWealthPercentile() {
  return useQuery({
    queryKey: queryKeys.wealthPercentile(),
    queryFn: () => api.wealthPercentile(),
  });
}
