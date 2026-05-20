import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { api } from "../api";
import type { AssetGroupSlug } from "../types";
import {
  fetchAssetGroupBundle,
  fetchDashboardBundle,
  fetchInversionesBundle,
  fetchSidebarAccounts,
} from "./fetchers";
import { queryKeys, type DisplayUnit } from "./keys";

export function useDashboardBundle(unit: DisplayUnit) {
  return useQuery({
    queryKey: queryKeys.dashboard(unit),
    queryFn: () => fetchDashboardBundle(unit),
  });
}

export function useAssetGroupBundle(slug: AssetGroupSlug, unit: DisplayUnit) {
  return useQuery({
    queryKey: queryKeys.assetGroup(slug, unit),
    queryFn: () => fetchAssetGroupBundle(slug, unit),
  });
}

export function useInversionesBundle(opts: {
  apiGroup: string;
  apiSubgroup?: string;
  navScope: "root" | "retiro" | "brokerage";
  brkFetchSub?: string;
  unit: DisplayUnit;
  enabled: boolean;
}) {
  const { enabled, apiGroup, apiSubgroup, navScope, brkFetchSub, unit } = opts;
  return useQuery({
    queryKey: queryKeys.inversiones(apiGroup, apiSubgroup, navScope, unit),
    queryFn: () =>
      fetchInversionesBundle({ apiGroup, apiSubgroup, navScope, brkFetchSub, unit }),
    enabled,
  });
}

export function useSidebarAccounts() {
  return useQuery({
    queryKey: queryKeys.sidebarAccounts(),
    queryFn: fetchSidebarAccounts,
    staleTime: 60_000,
  });
}

export function useSidebarNav() {
  return useQuery({
    queryKey: queryKeys.sidebarNav(),
    queryFn: () => api.sidebarNav(),
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

export function useAccountMonthlyPerformance(id: string | undefined, unit: DisplayUnit) {
  return useQuery({
    queryKey: queryKeys.accountMonthlyPerformance(id ?? "", unit),
    queryFn: () => api.accountMonthlyPerformance(id!, unit),
    enabled: Boolean(id),
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
    queryFn: async () => {
      const [s, m, f, series, dep, ml, cc, inv] = await Promise.all([
        api.accountSummary(id!),
        api.accountMovements(id!),
        api.brokerageFlows(id!).catch(() => ({ flows: [] })),
        api.accountValuationTimeseries(id!, unit, { granularity: chartGranularity }),
        api.accountDepositInflows(id!),
        api.accountMortgageLedger(id!).catch(() => ({
          account_id: Number(id),
          source: "none" as const,
          meta: null,
          rows: [],
        })),
        api.accountCcInstallments(id!, extraCcOffsets).catch(() => ({
          account_id: Number(id),
          source: "none" as const,
          meta: null,
          purchases: [],
          purchases_completed: [],
          months: [],
          totals: {
            total_remaining_principal_clp: 0,
            next_calendar_month_total_clp: null,
            next_calendar_month: null,
          },
        })),
        api.accountsByGroup("inversiones"),
      ]);
      return {
        summary: s,
        movements: m.movements ?? [],
        flows: f.flows ?? [],
        ts: series,
        depositInflows: dep,
        mortgageLedger: ml,
        ccLedger: cc,
        invNavAccounts: inv.accounts,
      };
    },
    enabled: Boolean(id),
  });
}
