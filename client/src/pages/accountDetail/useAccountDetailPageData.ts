import { useDeferredValue, useLayoutEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import {
  filterPointsThroughAsOfDate,
  resolveMonthlyPerfClipEndDate,
} from "../../components/charts/chartData";
import { useAccountDetailBundle, useDashboardNavContext, useDashboardNavSnapshot, useSidebarNav } from "../../queries/hooks";
import { hasDashboardNavSnapshotCache } from "../../queries/dashboardNavSnapshotCache";
import { dashPickForNavStrip } from "../../queries/fetchers";
import { useDisplayPreferences } from "../../context/DisplayPreferencesContext";
import { rollupPerfPointsYearly, rollupTimeseriesBlockYearEnd } from "../../dashboardTimeseriesYearly";
import { chartStrokeFromRgbTriplet } from "../../chartColors";
import { findNavTreeNodeByAccountId } from "../../portfolioNavFromApi";
import i18n from "../../i18n";
import { buildPlaceholderAccountDetailBundle } from "../../placeholders/accountDetailPlaceholders";
import {
  convertAccountDetailBundleUnit,
  resolveClpPerUsdForKeepPrev,
} from "../../placeholders/keepPrevBundleUnit";
import { readFxLatestCache } from "../../queries/fxLatestCache";
import type { EntityColorTarget } from "../../entityColor";
import {
  accountCardTitleBalanceDelta,
  cardGroupMetricsFromAccounts,
  type CardGroupMetricsPeriod,
} from "../../dashboardCardBreakdown";
import type {
  AccountCcInstallmentsResponse,
  AccountMonthlyPerformanceResponse,
  CheckingCartolaMonthsResponse,
  DashboardAccountRow,
  PeriodReturnsPayload,
} from "../../types";
import { CC_EXTRA_OFFSET_LS } from "./shared";

type DetailBundle = NonNullable<ReturnType<typeof useAccountDetailBundle>["data"]>;

export type AccountDetailPageData = {
  id: string | undefined;
  contentLoading: boolean;
  err: string | null;
  monthlyPerfErr: string | null;
  summary: NonNullable<DetailBundle["summary"]>;
  ts: NonNullable<DetailBundle["ts"]>;
  depositInflows: DetailBundle["depositInflows"];
  mortgageLedger: NonNullable<DetailBundle["mortgageLedger"]>;
  ccLedger: AccountCcInstallmentsResponse;
  checkingCartolaMonths: CheckingCartolaMonthsResponse | null;
  invNavAccounts: DetailBundle["invNavAccounts"]["accounts"];
  dash: ReturnType<typeof dashPickForNavStrip> | null;
  monthlyPerf: AccountMonthlyPerformanceResponse | null;
  periodReturns: PeriodReturnsPayload | null;
  displayUnit: "clp" | "usd";
  metricsPeriod: CardGroupMetricsPeriod;
  isYearly: boolean;
  xAxisGranularity: "month" | "year";
  extraCcOffsets: Record<string, number>;
  setExtraCcOffsets: (next: Record<string, number>) => void;
  valuationTailClipEndDate: string | null;
  monthlyPerfRows: AccountMonthlyPerformanceResponse["monthly"];
  ytdChartPoints: Record<string, string | number | null>[];
  accChartPoints: Record<string, string | number | null>[];
  valuationBlockForChart: NonNullable<DetailBundle["ts"]>["accounts"] | null;
  navSelf: ReturnType<typeof findNavTreeNodeByAccountId>;
  accountColorRgb: string | null;
  pageColorTarget: EntityColorTarget | undefined;
  accountChartTheme: { bar: string; areaStroke: string; areaFill: string };
  accountDashRow: DashboardAccountRow | null;
  accountTitleDelta: ReturnType<typeof accountCardTitleBalanceDelta>;
  accountMetricsAgg: ReturnType<typeof cardGroupMetricsFromAccounts>;
  accountNavChildren: NonNullable<ReturnType<typeof findNavTreeNodeByAccountId>>["children"];
  chartUsdVal: number | null;
};

export function useAccountDetailPageData(): AccountDetailPageData {
  const { id } = useParams();
  const [extraCcOffsets, setExtraCcOffsets] = useState<Record<string, number>>({});
  const { displayUnit, metricsPeriod } = useDisplayPreferences();
  const isYearly = metricsPeriod === "year";
  const xAxisGranularity = isYearly ? "year" : "month";
  const deferredCcOffsets = useDeferredValue(extraCcOffsets);

  const accountIdNum = id != null && Number.isFinite(Number(id)) && Number(id) > 0 ? Number(id) : 0;

  const {
    data: rawDetail,
    error: detailError,
    isPending: detailPending,
    isPlaceholderData: detailIsPlaceholder,
  } = useAccountDetailBundle(id, displayUnit, "monthly", deferredCcOffsets);

  // During a CLP↔USD switch keepPreviousData holds the prior-unit bundle; convert its
  // toggle-responsive surfaces (chart, monthly perf, header card) to the target unit so the
  // page stays consistent instead of briefly showing prior-unit magnitudes under the new symbol.
  const detail = useMemo(() => {
    if (!detailIsPlaceholder || !rawDetail) return rawDetail;
    if (rawDetail.ts && rawDetail.ts.unit === (displayUnit === "usd" ? "usd" : "clp")) return rawDetail;
    const rate = resolveClpPerUsdForKeepPrev(undefined, readFxLatestCache());
    if (rate == null) return rawDetail;
    return convertAccountDetailBundleUnit(rawDetail, displayUnit, rate);
  }, [detailIsPlaceholder, rawDetail, displayUnit]);
  const { data: sidebarNav } = useSidebarNav();
  const { data: navSnapshot } = useDashboardNavSnapshot(displayUnit);

  const placeholder = useMemo(
    () => buildPlaceholderAccountDetailBundle(accountIdNum > 0 ? accountIdNum : 1, displayUnit),
    [accountIdNum, displayUnit]
  );

  const err =
    detailError instanceof Error
      ? detailError.message
      : detailError
        ? i18n.t("common.loadFailed")
        : null;

  const bundleReady =
    detail?.summary != null &&
    detail.ts != null &&
    detail.depositInflows != null &&
    detail.mortgageLedger != null &&
    detail.ccLedger != null &&
    detail.invNavAccounts?.accounts != null;

  const contentLoading = detailPending || !bundleReady;

  const summary = detail?.summary ?? placeholder.summary;
  const ts: NonNullable<DetailBundle["ts"]> = detail?.ts ?? placeholder.ts!;
  const depositInflows = detail?.depositInflows ?? placeholder.depositInflows;
  const mortgageLedger = detail?.mortgageLedger ?? placeholder.mortgageLedger;
  const ccLedger = (detail?.ccLedger ?? placeholder.ccLedger) as AccountCcInstallmentsResponse;
  const invNavAccounts = detail?.invNavAccounts?.accounts ?? placeholder.invNavAccounts.accounts;
  const monthlyPerf = detail?.monthly_performance ?? placeholder.monthly_performance;
  const periodReturns = detail?.period_returns ?? null;
  const checkingCartolaMonths = detail?.checkingCartolaMonths ?? null;

  const accountIdForNav = accountIdNum > 0 ? accountIdNum : summary.account_id;
  const navSelfEarly = useMemo(() => {
    if (!Number.isFinite(accountIdForNav) || accountIdForNav <= 0) return null;
    return findNavTreeNodeByAccountId(sidebarNav?.main ?? [], accountIdForNav);
  }, [sidebarNav?.main, accountIdForNav]);
  const needsNavChildCards =
    (navSelfEarly?.children?.filter((c) => c.route_path?.trim()).length ?? 0) > 0;

  const hasNavSnapshotCache = hasDashboardNavSnapshotCache(displayUnit);
  const { data: navCtx } = useDashboardNavContext(
    displayUnit,
    needsNavChildCards && (!hasNavSnapshotCache || bundleReady)
  );
  const dash = navCtx ? dashPickForNavStrip(navCtx, sidebarNav?.net_worth) : null;

  const monthlyPerfErr: string | null = null;

  // Tail clip runs server-side; the block carries the clipped x-range when the account ended early.
  const valuationTailClipEndDate = ts?.accounts?.chart_end_ymd ?? null;

  const monthlyPerfRows = useMemo(() => {
    const rows = monthlyPerf?.monthly ?? [];
    const clipEnd = resolveMonthlyPerfClipEndDate(valuationTailClipEndDate, rows);
    return filterPointsThroughAsOfDate(rows, clipEnd);
  }, [monthlyPerf?.monthly, valuationTailClipEndDate]);

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


  useLayoutEffect(() => {
    if (!id) return;
    try {
      setExtraCcOffsets(JSON.parse(localStorage.getItem(`${CC_EXTRA_OFFSET_LS}:${id}`) || "{}"));
    } catch {
      setExtraCcOffsets({});
    }
  }, [id]);

  const navSelf = navSelfEarly;

  const accountColorRgb = useMemo(() => {
    return ts.accounts.accounts?.find((a) => a.account_id === summary.account_id)?.color_rgb ?? null;
  }, [summary.account_id, ts.accounts.accounts]);

  const pageColorTarget = useMemo((): EntityColorTarget | undefined => {
    const accountId = summary.account_id;
    if (!Number.isFinite(accountId) || accountId <= 0) return undefined;
    return { kind: "account", accountId };
  }, [summary.account_id]);

  const accountChartTheme = useMemo(
    () => ({
      bar: chartStrokeFromRgbTriplet(accountColorRgb),
      areaStroke: "#64748b",
      areaFill: "rgba(148, 163, 184, 0.22)",
    }),
    [accountColorRgb]
  );

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

  const accountDashRow = useMemo(() => {
    if (summary.account_id <= 0) return null;
    if (detail?.dashboard_account_row) return detail.dashboard_account_row;
    const fromNavCtx = dash?.accounts.find((a) => a.account_id === summary.account_id) ?? null;
    if (fromNavCtx) return fromNavCtx;
    return navSnapshot?.accounts.find((a) => a.account_id === summary.account_id) ?? null;
  }, [detail?.dashboard_account_row, dash?.accounts, navSnapshot, summary.account_id]);
  const accountTitleDelta =
    accountDashRow != null
      ? accountCardTitleBalanceDelta(accountDashRow, metricsPeriod, displayUnit === "usd")
      : null;
  const accountMetricsAgg = cardGroupMetricsFromAccounts(accountDashRow ? [accountDashRow] : [], metricsPeriod);
  const accountNavChildren = navSelf?.children?.filter((c) => c.route_path?.trim()) ?? [];

  return {
    id,
    contentLoading: err != null ? false : contentLoading,
    err,
    monthlyPerfErr,
    summary,
    ts,
    depositInflows,
    mortgageLedger,
    ccLedger,
    checkingCartolaMonths,
    invNavAccounts,
    dash,
    monthlyPerf,
    periodReturns,
    displayUnit,
    metricsPeriod,
    isYearly,
    xAxisGranularity,
    extraCcOffsets,
    setExtraCcOffsets,
    valuationTailClipEndDate,
    monthlyPerfRows,
    ytdChartPoints,
    accChartPoints,
    valuationBlockForChart,
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
