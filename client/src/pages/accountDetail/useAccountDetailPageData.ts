import { useDeferredValue, useLayoutEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import {
  filterPointsThroughAsOfDate,
  trailingZeroTailClipLastVisibleDate,
} from "../../components/charts/AppLineChart";
import {
  buildLineChartTailClipOptions,
  trimLeadingInactivePoints,
} from "../../components/charts/ValuationLineCharts";
import { useAccountDetailBundle, useAccountMonthlyPerformance, useDashboardBundle, useSidebarNav } from "../../queries/hooks";
import { useDisplayPreferences } from "../../context/DisplayPreferencesContext";
import { rollupPerfPointsYearly, rollupTimeseriesBlockYearEnd } from "../../dashboardTimeseriesYearly";
import { filterAccountFlowsPersonalOnly, accountMovementsToFlowRows } from "../../accountFlows";
import { chartStrokeFromRgbTriplet } from "../../chartColors";
import { findNavTreeNodeByAccountId } from "../../portfolioNavFromApi";
import type { EntityColorTarget } from "../../entityColor";
import {
  accountCardTitleBalanceDelta,
  cardGroupMetricsFromAccounts,
} from "../../dashboardCardBreakdown";
import type { AccountCcInstallmentsResponse, CheckingCartolaMonthsResponse } from "../../types";
import { CC_EXTRA_OFFSET_LS } from "./shared";

type DetailBundle = NonNullable<ReturnType<typeof useAccountDetailBundle>["data"]>;

export type AccountDetailPageData = {
  id: string | undefined;
  detailPending: boolean;
  err: string | null;
  monthlyPerfErr: string | null;
  summary: NonNullable<DetailBundle["summary"]>;
  ts: NonNullable<DetailBundle["ts"]>;
  depositInflows: DetailBundle["depositInflows"];
  mortgageLedger: NonNullable<DetailBundle["mortgageLedger"]>;
  ccLedger: AccountCcInstallmentsResponse;
  checkingCartolaMonths: CheckingCartolaMonthsResponse | null;
  invNavAccounts: NonNullable<DetailBundle["invNavAccounts"]>;
  movements: DetailBundle["movements"];
  dash: ReturnType<typeof useDashboardBundle>["data"] extends infer D
    ? D extends { dash: infer Dd }
      ? Dd
      : null
    : null;
  overviewPoints: Record<string, string | number | null>[];
  monthlyPerf: ReturnType<typeof useAccountMonthlyPerformance>["data"];
  displayUnit: "clp" | "usd";
  metricsPeriod: "month" | "year";
  isYearly: boolean;
  xAxisGranularity: "month" | "year";
  movementsOnlyPersonalDeposits: boolean;
  setMovementsOnlyPersonalDeposits: (v: boolean) => void;
  extraCcOffsets: Record<string, number>;
  setExtraCcOffsets: (next: Record<string, number>) => void;
  valuationTailClipEndDate: string | null;
  monthlyPerfRows: NonNullable<ReturnType<typeof useAccountMonthlyPerformance>["data"]>["monthly"];
  ytdChartPoints: Record<string, string | number | null>[];
  accChartPoints: Record<string, string | number | null>[];
  valuationBlockForChart: NonNullable<DetailBundle["ts"]>["accounts"] | null;
  allFlows: ReturnType<typeof accountMovementsToFlowRows>;
  displayedFlows: ReturnType<typeof accountMovementsToFlowRows>;
  navSelf: ReturnType<typeof findNavTreeNodeByAccountId>;
  accountColorRgb: string | null;
  pageColorTarget: EntityColorTarget | undefined;
  accountChartTheme: { bar: string; areaStroke: string; areaFill: string };
  accountDashRow: ReturnType<typeof useDashboardBundle>["data"] extends infer D
    ? D extends { dash: { accounts: infer A } }
      ? A extends (infer Row)[]
        ? Row | null
        : null
      : null
    : null;
  accountTitleDelta: ReturnType<typeof accountCardTitleBalanceDelta>;
  accountMetricsAgg: ReturnType<typeof cardGroupMetricsFromAccounts>;
  accountNavChildren: NonNullable<ReturnType<typeof findNavTreeNodeByAccountId>>["children"];
  chartUsdVal: number | null;
};

export function useAccountDetailPageData(): AccountDetailPageData | { detailPending: true } | { err: string } | { loading: true } {
  const { id } = useParams();
  const [extraCcOffsets, setExtraCcOffsets] = useState<Record<string, number>>({});
  const { displayUnit, metricsPeriod } = useDisplayPreferences();
  const isYearly = metricsPeriod === "year";
  const xAxisGranularity = isYearly ? "year" : "month";
  const [movementsOnlyPersonalDeposits, setMovementsOnlyPersonalDeposits] = useState(false);
  const deferredCcOffsets = useDeferredValue(extraCcOffsets);

  const { data: detail, error: detailError, isPending: detailPending } = useAccountDetailBundle(
    id,
    displayUnit,
    "monthly",
    deferredCcOffsets
  );
  const { data: monthlyPerf, error: monthlyPerfError } = useAccountMonthlyPerformance(id, displayUnit);
  const { data: sidebarNav } = useSidebarNav();
  const { data: dashBundle } = useDashboardBundle(displayUnit);

  const summary = detail?.summary ?? null;
  const movements = detail?.movements ?? [];
  const ts = detail?.ts ?? null;
  const depositInflows = detail?.depositInflows ?? null;
  const mortgageLedger = detail?.mortgageLedger ?? null;
  const ccLedger = detail?.ccLedger ?? null;
  const invNavAccounts = detail?.invNavAccounts ?? null;
  const dash = dashBundle?.dash ?? null;
  const overviewPoints = dashBundle?.ts?.overview?.points ?? [];

  const err =
    detailError instanceof Error
      ? detailError.message
      : detailError
        ? "Failed to load"
        : null;
  const monthlyPerfErr =
    monthlyPerfError instanceof Error
      ? monthlyPerfError.message
      : monthlyPerfError
        ? "No se pudo cargar el rendimiento mensual."
        : null;

  const valuationTailClipEndDate = useMemo(() => {
    if (!ts?.accounts?.points?.length) return null;
    const block = trimLeadingInactivePoints(ts.accounts, true);
    const opts = buildLineChartTailClipOptions(block, true);
    if (!opts) return null;
    return trailingZeroTailClipLastVisibleDate(block.points, opts);
  }, [ts?.accounts]);

  const monthlyPerfRows = useMemo(
    () => filterPointsThroughAsOfDate(monthlyPerf?.monthly ?? [], valuationTailClipEndDate),
    [monthlyPerf?.monthly, valuationTailClipEndDate]
  );

  const ytdChartPoints = useMemo(() => {
    if (!monthlyPerfRows.length) return [];
    const monthly = [...monthlyPerfRows].reverse().map((r) => ({
      as_of_date: r.as_of_date,
      nominal_pl: r.nominal_pl ?? 0,
      ytd_nominal_pl: r.ytd_nominal_pl ?? 0,
    }));
    if (!isYearly) return monthly;
    return rollupPerfPointsYearly(monthly, {
      sumKeys: ["nominal_pl"],
      ytdKey: "ytd_nominal_pl",
    });
  }, [monthlyPerfRows, isYearly]);

  const accChartPoints = useMemo(() => {
    if (!monthlyPerfRows.length) return [];
    const monthly = [...monthlyPerfRows].reverse().map((r) => ({
      as_of_date: r.as_of_date,
      delta_month: r.nominal_pl ?? 0,
      accumulated_earnings: r.cumulative_nominal_pl ?? 0,
    }));
    if (!isYearly) return monthly;
    return rollupPerfPointsYearly(monthly, {
      sumKeys: ["delta_month"],
      accumKey: "accumulated_earnings",
    });
  }, [monthlyPerfRows, isYearly]);

  const valuationBlockForChart = useMemo(() => {
    if (!ts?.accounts) return null;
    if (!isYearly) return ts.accounts;
    return rollupTimeseriesBlockYearEnd(ts.accounts);
  }, [ts?.accounts, isYearly]);

  const allFlows = useMemo(() => accountMovementsToFlowRows(movements), [movements]);
  const displayedFlows = useMemo(() => {
    if (!movementsOnlyPersonalDeposits) return allFlows;
    return filterAccountFlowsPersonalOnly(allFlows);
  }, [allFlows, movementsOnlyPersonalDeposits]);

  useLayoutEffect(() => {
    if (!id) return;
    try {
      setExtraCcOffsets(JSON.parse(localStorage.getItem(`${CC_EXTRA_OFFSET_LS}:${id}`) || "{}"));
    } catch {
      setExtraCcOffsets({});
    }
  }, [id]);

  const navSelf = useMemo(() => {
    const accountId = summary?.account_id ?? (id ? Number(id) : NaN);
    if (!Number.isFinite(accountId) || accountId <= 0) return null;
    return findNavTreeNodeByAccountId(sidebarNav?.main ?? [], accountId);
  }, [sidebarNav?.main, summary?.account_id, id]);

  const accountColorRgb = useMemo(() => {
    if (summary == null || ts == null) return null;
    return ts.accounts.accounts?.find((a) => a.account_id === summary.account_id)?.color_rgb ?? null;
  }, [summary, ts?.accounts.accounts]);

  const pageColorTarget = useMemo((): EntityColorTarget | undefined => {
    const accountId = summary?.account_id ?? (id ? Number(id) : NaN);
    if (!Number.isFinite(accountId) || accountId <= 0) return undefined;
    return { kind: "account", accountId };
  }, [summary?.account_id, id]);

  const accountChartTheme = useMemo(
    () => ({
      bar: chartStrokeFromRgbTriplet(accountColorRgb),
      areaStroke: "#64748b",
      areaFill: "rgba(148, 163, 184, 0.22)",
    }),
    [accountColorRgb]
  );

  if (detailPending) return { detailPending: true };
  if (err) return { err };
  if (!summary || !ts || !depositInflows || !mortgageLedger || !ccLedger || invNavAccounts == null) {
    return { loading: true };
  }

  const lastChartRow =
    ts.accounts.points.length > 0 ? ts.accounts.points[ts.accounts.points.length - 1]! : null;
  const accountDataKey = String(summary.account_id);
  const chartUsdVal =
    displayUnit === "usd" &&
    lastChartRow &&
    typeof lastChartRow[accountDataKey] === "number" &&
    Number.isFinite(lastChartRow[accountDataKey] as number)
      ? (lastChartRow[accountDataKey] as number)
      : null;

  const accountDashRow = dash?.accounts.find((a) => a.account_id === summary.account_id) ?? null;
  const accountTitleDelta =
    accountDashRow != null
      ? accountCardTitleBalanceDelta(accountDashRow, metricsPeriod, displayUnit === "usd")
      : null;
  const accountMetricsAgg = cardGroupMetricsFromAccounts(accountDashRow ? [accountDashRow] : [], metricsPeriod);
  const accountNavChildren = navSelf?.children?.filter((c) => c.route_path?.trim()) ?? [];

  return {
    id,
    detailPending: false,
    err: null,
    monthlyPerfErr,
    summary,
    ts,
    depositInflows,
    mortgageLedger,
    ccLedger: ccLedger as AccountCcInstallmentsResponse,
    checkingCartolaMonths: detail?.checkingCartolaMonths ?? null,
    invNavAccounts,
    movements,
    dash,
    overviewPoints,
    monthlyPerf,
    displayUnit,
    metricsPeriod,
    isYearly,
    xAxisGranularity,
    movementsOnlyPersonalDeposits,
    setMovementsOnlyPersonalDeposits,
    extraCcOffsets,
    setExtraCcOffsets,
    valuationTailClipEndDate,
    monthlyPerfRows,
    ytdChartPoints,
    accChartPoints,
    valuationBlockForChart,
    allFlows,
    displayedFlows,
    navSelf,
    accountColorRgb,
    pageColorTarget,
    accountChartTheme,
    accountDashRow,
    accountTitleDelta,
    accountMetricsAgg,
    accountNavChildren,
    chartUsdVal,
  };
}
