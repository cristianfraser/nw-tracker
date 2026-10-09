import { useMemo } from "react";
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
import { buildPlaceholderNavStripDash } from "../../placeholders/dashboardPagePlaceholders";
import {
  convertAccountDetailBundleUnit,
  convertPeriodReturnsUnit,
  resolveClpPerUsdForKeepPrev,
} from "../../placeholders/keepPrevBundleUnit";
import { readFxLatestCache } from "../../queries/fxLatestCache";
import { cardGroupMetricsByPeriodFromAccounts } from "../../dashboardCardBreakdown";
import { useSurfacePrefs, type SurfacePrefsValue } from "../../surfaceDisplayPrefs";
import { clipMonthsThenRollup } from "../../timeRange";
import type {
  AccountCcInstallmentsResponse,
  AccountMonthlyPerformanceResponse,
  CheckingCartolaMonthsResponse,
  DashboardAccountRow,
  PeriodReturnsPayload,
} from "../../types";

type DetailBundle = NonNullable<ReturnType<typeof useAccountDetailBundle>["data"]>;

export type AccountDetailPageData = {
  id: string | undefined;
  /**
   * The bundle is not in yet, or is held prior-unit data being converted: the page keeps its
   * layout and dims (the category-keyed frames come from the placeholder, see
   * `placeholderCategorySlug`).
   */
  contentLoading: boolean;
  err: string | null;
  summary: NonNullable<DetailBundle["summary"]>;
  ts: NonNullable<DetailBundle["ts"]>;
  depositInflows: DetailBundle["depositInflows"];
  mortgageLedger: NonNullable<DetailBundle["mortgageLedger"]>;
  ccLedger: AccountCcInstallmentsResponse;
  checkingCartolaMonths: CheckingCartolaMonthsResponse | null;
  invNavAccounts: DetailBundle["invNavAccounts"]["accounts"];
  dash: ReturnType<typeof dashPickForNavStrip> | null;
  /** `dash` is the nav-tree zero frame (nav-context not in yet): its cards are in the placeholder phase. */
  dashIsPlaceholder: boolean;
  monthlyPerf: AccountMonthlyPerformanceResponse | null;
  /** undefined while the bundle loads; null is the server stating the account has no period returns. */
  periodReturns: PeriodReturnsPayload | null | undefined;
  displayUnit: "clp" | "usd";
  /** Per-surface controls: valuation chart (Diario+3y) and the two P/L combos (Mensual+3y). */
  valuationPrefs: SurfacePrefsValue;
  perfPrefs: SurfacePrefsValue;
  valuationTailClipEndDate: string | null;
  monthlyPerfRows: AccountMonthlyPerformanceResponse["monthly"];
  ytdChartPoints: Record<string, string | number | null>[];
  accChartPoints: Record<string, string | number | null>[];
  valuationBlockForChart: NonNullable<DetailBundle["ts"]>["accounts"] | null;
  navSelf: ReturnType<typeof findNavTreeNodeByAccountId>;
  accountChartTheme: { bar: string; areaStroke: string; areaFill: string };
  accountDashRow: DashboardAccountRow | null;
  accountMetricsAgg: ReturnType<typeof cardGroupMetricsByPeriodFromAccounts>;
  accountNavChildren: NonNullable<ReturnType<typeof findNavTreeNodeByAccountId>>["children"];
  chartUsdVal: number | null;
};

export function useAccountDetailPageData(): AccountDetailPageData {
  const { id } = useParams();
  const { displayUnit } = useDisplayPreferences();

  const accountIdNum = id != null && Number.isFinite(Number(id)) && Number(id) > 0 ? Number(id) : 0;
  const valuationPrefs = useSurfacePrefs(`account.${accountIdNum || "pending"}.valuation`, "day", "3y");
  const perfPrefs = useSurfacePrefs(`account.${accountIdNum || "pending"}.combos`, "month", "3y");
  const perfIsYearly = perfPrefs.period === "year";
  const perfRange = perfPrefs.range;

  const {
    data: rawDetail,
    error: detailError,
    isPending: detailPending,
    isPlaceholderData: detailIsPlaceholder,
  } = useAccountDetailBundle(id, displayUnit, "monthly");

  // During a CLP↔USD switch keepPreviousData holds the prior-unit bundle; convert its
  // toggle-responsive surfaces (chart, monthly perf, header card) to the target unit so the
  // page stays consistent instead of briefly showing prior-unit magnitudes under the new symbol.
  const detail = useMemo(() => {
    if (!detailIsPlaceholder || !rawDetail) return rawDetail;
    if (rawDetail.ts && rawDetail.ts.unit === (displayUnit === "usd" ? "usd" : "clp")) return rawDetail;
    const rate = resolveClpPerUsdForKeepPrev(undefined, readFxLatestCache());
    if (rate == null) return rawDetail;
    const converted = convertAccountDetailBundleUnit(rawDetail, displayUnit, rate);
    // The Rentabilidad table stays on screen (dimmed) while the target unit loads, so its money
    // cells convert too.
    return converted.period_returns
      ? {
          ...converted,
          period_returns: convertPeriodReturnsUnit(converted.period_returns, displayUnit, rate),
        }
      : converted;
  }, [detailIsPlaceholder, rawDetail, displayUnit]);
  const { data: sidebarNav } = useSidebarNav();
  const { data: navSnapshot } = useDashboardNavSnapshot(displayUnit);

  const navSelfEarly = useMemo(() => {
    if (accountIdNum <= 0) return null;
    return findNavTreeNodeByAccountId(sidebarNav?.main ?? [], accountIdNum);
  }, [sidebarNav?.main, accountIdNum]);
  // What the client already knows about the account (its nav node, its card row in the cached nav
  // snapshot): the placeholder takes its category and name from there, so category-keyed sections
  // frame the right page from first paint.
  const placeholderDashRow = useMemo(
    () => navSnapshot?.accounts.find((a) => a.account_id === accountIdNum) ?? null,
    [navSnapshot, accountIdNum]
  );

  const placeholder = useMemo(
    () =>
      buildPlaceholderAccountDetailBundle(accountIdNum > 0 ? accountIdNum : 1, displayUnit, {
        navNode: navSelfEarly,
        dashRow: placeholderDashRow,
      }),
    [accountIdNum, displayUnit, navSelfEarly, placeholderDashRow]
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

  // `detailIsPlaceholder` = prior-unit data of this same account held while the new unit loads.
  const contentLoading = detailPending || detailIsPlaceholder || !bundleReady;

  const summary = detail?.summary ?? placeholder.summary;
  const ts: NonNullable<DetailBundle["ts"]> = detail?.ts ?? placeholder.ts!;
  const depositInflows = detail?.depositInflows ?? placeholder.depositInflows;
  const mortgageLedger = detail?.mortgageLedger ?? placeholder.mortgageLedger;
  const ccLedger = (detail?.ccLedger ?? placeholder.ccLedger) as AccountCcInstallmentsResponse;
  const invNavAccounts = detail?.invNavAccounts?.accounts ?? placeholder.invNavAccounts.accounts;
  const monthlyPerf = detail?.monthly_performance ?? placeholder.monthly_performance;
  const periodReturns = detail?.period_returns;
  const checkingCartolaMonths = detail?.checkingCartolaMonths ?? null;

  const needsNavChildCards =
    (navSelfEarly?.children?.filter((c) => c.route_path?.trim()).length ?? 0) > 0;

  const hasNavSnapshotCache = hasDashboardNavSnapshotCache(displayUnit);
  const { data: navCtx } = useDashboardNavContext(
    displayUnit,
    needsNavChildCards && (!hasNavSnapshotCache || bundleReady)
  );
  const realDash = navCtx ? dashPickForNavStrip(navCtx) : null;
  // Nav-context not in yet: the strip's zero frame from the nav tree (cards in their placeholder phase).
  const dash =
    realDash ??
    (needsNavChildCards && sidebarNav ? buildPlaceholderNavStripDash(sidebarNav, displayUnit) : null);
  const dashIsPlaceholder = realDash == null && dash != null;

  // Tail clip runs server-side; the block carries the clipped x-range when the account ended early.
  const valuationTailClipEndDate = ts?.accounts?.chart_end_ymd ?? null;

  const monthlyPerfRows = useMemo(() => {
    const rows = monthlyPerf?.monthly ?? [];
    const clipEnd = resolveMonthlyPerfClipEndDate(valuationTailClipEndDate, rows);
    return filterPointsThroughAsOfDate(rows, clipEnd);
  }, [monthlyPerf?.monthly, valuationTailClipEndDate]);

  // Yearly combos: months cut at the combos' Rango first, then rolled up (a partial first year).
  const ytdChartPoints = useMemo(() => {
    if (!monthlyPerfRows.length) return [];
    const monthly = [...monthlyPerfRows].reverse().map((r) => ({
      as_of_date: r.as_of_date,
      nominal_pl: r.nominal_pl ?? 0,
      ytd_nominal_pl: r.ytd_nominal_pl ?? 0,
    }));
    if (!perfIsYearly) return monthly;
    return clipMonthsThenRollup(monthly, "year", perfRange, (months) =>
      rollupPerfPointsYearly(months, {
        sumKeys: ["nominal_pl"],
        ytdKey: "ytd_nominal_pl",
      })
    );
  }, [monthlyPerfRows, perfIsYearly, perfRange]);

  const accChartPoints = useMemo(() => {
    if (!monthlyPerfRows.length) return [];
    const monthly = [...monthlyPerfRows].reverse().map((r) => ({
      as_of_date: r.as_of_date,
      delta_month: r.nominal_pl ?? 0,
      accumulated_earnings: r.cumulative_nominal_pl ?? 0,
    }));
    if (!perfIsYearly) return monthly;
    return clipMonthsThenRollup(monthly, "year", perfRange, (months) =>
      rollupPerfPointsYearly(months, {
        sumKeys: ["delta_month"],
        accumKey: "accumulated_earnings",
      })
    );
  }, [monthlyPerfRows, perfIsYearly, perfRange]);

  const valuationBlockForChart = useMemo(() => {
    if (!ts?.accounts) return null;
    if (valuationPrefs.period !== "year") return ts.accounts;
    return rollupTimeseriesBlockYearEnd(ts.accounts);
  }, [ts?.accounts, valuationPrefs.period]);


  const navSelf = navSelfEarly;

  const accountColorRgb = useMemo(() => {
    return ts.accounts.accounts?.find((a) => a.account_id === summary.account_id)?.color_rgb ?? null;
  }, [summary.account_id, ts.accounts.accounts]);

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
  const accountMetricsAgg = cardGroupMetricsByPeriodFromAccounts(accountDashRow ? [accountDashRow] : []);
  const accountNavChildren = navSelf?.children?.filter((c) => c.route_path?.trim()) ?? [];

  return {
    id,
    contentLoading: err != null ? false : contentLoading,
    err,
    summary,
    ts,
    depositInflows,
    mortgageLedger,
    ccLedger,
    checkingCartolaMonths,
    invNavAccounts,
    dash,
    dashIsPlaceholder,
    monthlyPerf,
    periodReturns,
    displayUnit,
    valuationPrefs,
    perfPrefs,
    valuationTailClipEndDate,
    monthlyPerfRows,
    ytdChartPoints,
    accChartPoints,
    valuationBlockForChart,
    navSelf,
    accountChartTheme,
    accountDashRow,
    accountMetricsAgg,
    accountNavChildren,
    chartUsdVal,
  };
}
