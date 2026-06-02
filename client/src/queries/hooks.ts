import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { api } from "../api";
import {
  fetchDashboardBundle,
  fetchDashboardNavContext,
  fetchPortfolioGroupBundle,
} from "./fetchers";
import { displayUnitQueryBehavior } from "./displayUnitQueries";
import { queryKeys, type DisplayUnit } from "./keys";
import { readSidebarNavCache, writeSidebarNavCache } from "./sidebarNavCache";

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

export function usePortfolioGroupBundle(opts: {
  portfolio_group: string;
  unit: DisplayUnit;
  enabled?: boolean;
}) {
  const { portfolio_group, unit, enabled = true } = opts;
  return useQuery({
    queryKey: queryKeys.portfolioGroup(portfolio_group, undefined, unit),
    queryFn: () => fetchPortfolioGroupBundle({ portfolio_group, unit }),
    enabled: enabled && Boolean(portfolio_group),
    ...displayUnitQueryBehavior,
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

export function useAccountsAll() {
  return useQuery({
    queryKey: queryKeys.accountsAll(),
    queryFn: () => api.accountsAll(),
    staleTime: 60_000,
  });
}

export function useAssetTree() {
  return useQuery({
    queryKey: queryKeys.assetTree(),
    queryFn: () => api.assetTree(),
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

export function useFlowsExpenses() {
  return useQuery({
    queryKey: queryKeys.flowsExpenses(),
    queryFn: () => api.flowsExpenses(),
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
