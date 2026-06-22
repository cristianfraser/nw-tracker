import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { api } from "../api";
import {
  fetchAccountsByPortfolioGroup,
  fetchDashboardBundle,
  fetchDashboardNavContext,
  fetchDashboardNavSnapshot,
  fetchPortfolioGroupBundle,
} from "./fetchers";
import { readDashboardNavSnapshotCache, writeDashboardNavSnapshotCache } from "./dashboardNavSnapshotCache";
import { readFxLatestCache } from "./fxLatestCache";
import { DISPLAY_UNIT_STALE_MS, displayUnitQueryBehavior } from "./displayUnitQueries";
import { queryKeys, type DisplayUnit } from "./keys";
import { buildGroupPageShellFromNav } from "../placeholders/groupPageShellFromNav";
import {
  perturbDashboardNavSnapshot,
  perturbGroupPageShell,
  synthesizeMissingUsdOnGroupPageShell,
  synthesizeMissingUsdOnNavSnapshot,
} from "../placeholders/perturbCachedAmount";
import { readGroupPageShellCache } from "./groupPageShellCache";
import { readSidebarNavCache, writeSidebarNavCache } from "./sidebarNavCache";
import type { GroupPageShell } from "./groupPageShell";
import type { NavTreeNodeDto } from "../types";

function readNavSnapshotCacheForUnit(unit: DisplayUnit) {
  const cachedFx = readFxLatestCache();
  const raw =
    readDashboardNavSnapshotCache(unit) ??
    (unit === "usd" ? readDashboardNavSnapshotCache("clp") : undefined);
  if (!raw) return undefined;
  const prepared = unit === "usd" ? synthesizeMissingUsdOnNavSnapshot(raw, cachedFx) : raw;
  return perturbDashboardNavSnapshot(prepared);
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

export function useDashboardBundle(unit: DisplayUnit, enabled = true) {
  return useQuery({
    queryKey: queryKeys.dashboard(unit),
    queryFn: () => fetchDashboardBundle(unit),
    enabled,
    ...displayUnitQueryBehavior,
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
    ...displayUnitQueryBehavior,
  });
}

const DASHBOARD_NAV_SNAPSHOT_STALE_MS = 10 * 60_000;

/** Home card strip shape (accounts + layout); cached in localStorage between visits. */
export function useDashboardNavSnapshot(unit: DisplayUnit, enabled = true) {
  return useQuery({
    queryKey: queryKeys.dashboardNavSnapshot(unit),
    queryFn: async () => {
      const snapshot = await fetchDashboardNavSnapshot(unit);
      writeDashboardNavSnapshotCache(unit, snapshot);
      return snapshot;
    },
    initialData: () => readNavSnapshotCacheForUnit(unit),
    enabled,
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
      const raw = readGroupPageShellCacheForUnit(portfolioGroup, unit);
      return raw ? perturbGroupPageShell(raw) : undefined;
    },
    enabled: enabled && Boolean(portfolioGroup && navNode),
    ...displayUnitQueryBehavior,
    staleTime: GROUP_PAGE_SHELL_STALE_MS,
    gcTime: GROUP_PAGE_SHELL_STALE_MS,
  });
}

export function useSidebarNav() {
  return useQuery({
    queryKey: queryKeys.sidebarNav(),
    queryFn: async () => {
      const data = await api.sidebarNav();
      writeSidebarNavCache(data);
      return data;
    },
    initialData: readSidebarNavCache,
    staleTime: 60_000,
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

export function useFlowsCreditCardExpenses() {
  return useQuery({
    queryKey: queryKeys.flowsCreditCardExpenses(),
    queryFn: () => api.flowsCreditCardExpenses(),
  });
}

export {
  useAssignCcExpenseLineCategory,
  useMarkCcExpenseLineUniqueMutation,
  useCreateCcPurchaseMutation,
  useDeleteCcPurchaseMutation,
  useDeleteCcStatementLineMutation,
  useAccountImportMutation,
  usePatchCcExpenseLineCategoryMutation,
  usePatchCcExpensePurchaseNoteMutation,
  usePutCcExpensePurchaseBigGroupMutation,
  useCreateCcExpenseBigGroupMutation,
  useRenameCcExpenseBigGroupMutation,
  useDeleteCcExpenseBigGroupMutation,
  useLinkRealEstateExpenseMutation,
  useUnmatchRealEstateExpenseMutation,
} from "./mutations";

export function useAccountMonthlyPerformance(id: string | undefined, unit: DisplayUnit) {
  return useQuery({
    queryKey: queryKeys.accountMonthlyPerformance(id ?? "", unit),
    queryFn: () => api.accountMonthlyPerformance(id!, unit),
    enabled: Boolean(id),
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
