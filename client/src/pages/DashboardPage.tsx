import { useEffect, useMemo } from "react";
import { Link } from "react-router-dom";
import { Cell, Legend, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { LineChartPanel, ValuationLineCharts } from "../components/ValuationLineCharts";
import { MonthlyPerformanceComboChart } from "../components/MonthlyPerformanceComboChart";
import { Table } from "../components/Table";
import { DashboardCardBreakdown } from "../components/DashboardCardBreakdown";
import { DashboardCardGroupMetrics } from "../components/DashboardCardGroupMetrics";
import { CompactEntityCard } from "../components/CompactEntityCard";
import { PortfolioEntityCardsStrip } from "../components/PortfolioEntityCardsStrip";
import { DetailedGroupCard } from "../components/DetailedGroupCard";
import { useDashboardBundle } from "../queries/hooks";
import { useDisplayPreferences } from "../context/DisplayPreferencesContext";
import {
  buildBrokerageCardBreakdown,
  buildCashCardBreakdown,
  cardGroupNetWorthTitleBalanceDelta,
  cardGroupTitleBalanceDelta,
  buildRealEstateCardBreakdown,
  buildRetirementCardBreakdown,
  cardGroupMetricsForGroup,
  cardGroupMetricsNetWorth,
} from "../dashboardCardBreakdown";
import { allocationBucketColor } from "../chartColors";
import { appendTrailingMovingAverage } from "../chartMovingAverage";
import {
  rollupRetirementBrokeragePerfYearly,
  rollupTimeseriesBlockYearEnd,
} from "../dashboardTimeseriesYearly";
import { useLoading } from "../context/LoadingContext";
import { useTranslation } from "../i18n";
import { formatClp, formatUsd, formatInstrumentUnits, formatMoneyForPie } from "../format";
import type { DashboardLayoutCardRow, ValuationTimeseriesResponse } from "../types";

const DASHBOARD_KNOWN_BUCKETS = new Set(["real_estate", "retirement", "brokerage", "cash_eqs"]);

/** Used when API omits `dashboard_layout` (e.g. before migration 035). Matches legacy order. */
const DEFAULT_DASHBOARD_BUCKET_LAYOUT: DashboardLayoutCardRow[] = [
  {
    slug: "real_estate",
    label: "Real estate",
    label_i18n_key: "dashboard.cards.realEstate",
    sort_order: 10,
    bucket_slug: "real_estate",
    card_css: null,
  },
  {
    slug: "retirement",
    label: "Retirement",
    label_i18n_key: "dashboard.cards.retirement",
    sort_order: 20,
    bucket_slug: "retirement",
    card_css: null,
  },
  {
    slug: "brokerage",
    label: "Brokerage",
    label_i18n_key: "dashboard.cards.inversiones",
    sort_order: 30,
    bucket_slug: "brokerage",
    card_css: null,
  },
  {
    slug: "cash_eqs",
    label: "Cash",
    label_i18n_key: "dashboard.cards.cash",
    sort_order: 40,
    bucket_slug: "cash_eqs",
    card_css: "cash",
  },
];
export function DashboardPage() {
  const { t } = useTranslation();
  const { setLoading } = useLoading();
  const { displayUnit, metricsPeriod } = useDisplayPreferences();
  const { data, error, isPending, isFetching } = useDashboardBundle(displayUnit);

  const dash = data?.dash ?? null;
  const ts = data?.ts ?? null;
  const retirementPerf = data?.retirementPerf ?? null;
  const brokeragePerf = data?.brokeragePerf ?? null;
  const err = error instanceof Error ? error.message : error ? t("common.loadFailed") : null;

  const showUsd = displayUnit === "usd";
  const unitSwitching = isFetching && !isPending;
  const isYearly = metricsPeriod === "year";
  const xAxisGranularity = isYearly ? "year" : "month";

  useEffect(() => {
    setLoading(isPending);
    return () => setLoading(false);
  }, [isPending, setLoading]);

  /** Union of retirement + brokerage group monthly Δ; YTD and cumulative on combined monthly Δ. */
  const retirementBrokeragePerfPoints = useMemo(() => {
    const retPts = retirementPerf?.points ?? [];
    const brkPts = brokeragePerf?.points ?? [];
    if (!retPts.length && !brkPts.length) return [];

    const deltaTotal = (p: Record<string, string | number | null>) => {
      const v = p.delta_total;
      return typeof v === "number" && Number.isFinite(v) ? v : 0;
    };

    const byDate = new Map<string, { ret: number; brk: number }>();
    for (const p of retPts) {
      const d = String(p.as_of_date ?? "");
      if (!d) continue;
      const cur = byDate.get(d) ?? { ret: 0, brk: 0 };
      cur.ret = deltaTotal(p);
      byDate.set(d, cur);
    }
    for (const p of brkPts) {
      const d = String(p.as_of_date ?? "");
      if (!d) continue;
      const cur = byDate.get(d) ?? { ret: 0, brk: 0 };
      cur.brk = deltaTotal(p);
      byDate.set(d, cur);
    }

    const datesAsc = [...byDate.keys()].sort((a, b) => a.localeCompare(b));
    let ytdYear = 0;
    let ytdRun = 0;
    let cumLife = 0;
    const out: Record<string, string | number | null>[] = [];
    for (const d of datesAsc) {
      const { ret, brk } = byDate.get(d)!;
      const combined = ret + brk;
      const y = Number(d.slice(0, 4));
      if (Number.isFinite(y) && y !== ytdYear) {
        ytdYear = y;
        ytdRun = 0;
      }
      ytdRun += combined;
      cumLife += combined;
      out.push({
        as_of_date: d,
        delta_retirement: ret,
        delta_brokerage: brk,
        delta_combined: combined,
        ytd_combined: ytdRun,
        accumulated_earnings: cumLife,
      });
    }
    return out;
  }, [retirementPerf, brokeragePerf]);

  const retirementBrokerageForCharts = useMemo(() => {
    if (!retirementBrokeragePerfPoints.length) return [];
    if (!isYearly) return retirementBrokeragePerfPoints;
    return rollupRetirementBrokeragePerfYearly(retirementBrokeragePerfPoints);
  }, [retirementBrokeragePerfPoints, isYearly]);

  const retirementBrokerageAccumChart = useMemo(() => {
    const depChart = dash?.inversiones_deposits_chart;
    const depositSeries = !depChart
      ? []
      : isYearly
        ? showUsd && depChart.yearly_usd
          ? depChart.yearly_usd
          : depChart.yearly_clp
        : showUsd && depChart.monthly_usd
          ? depChart.monthly_usd
          : depChart.monthly_clp;
    const depByDate = new Map(depositSeries.map((p) => [p.as_of_date, p.deposited]));
    let rows: Record<string, string | number | null>[] = retirementBrokerageForCharts.map((row) => ({
      ...row,
      deposits_inversiones: depByDate.get(String(row.as_of_date ?? "")) ?? 0,
    }));
    rows = appendTrailingMovingAverage(rows, "delta_combined", "delta_combined_ma3");
    rows = appendTrailingMovingAverage(rows, "deposits_inversiones", "deposits_inversiones_ma3");
    return rows;
  }, [retirementBrokerageForCharts, dash?.inversiones_deposits_chart, isYearly, showUsd]);

  const tsForCharts = useMemo((): ValuationTimeseriesResponse | null => {
    if (!ts?.accounts_ex_property || !ts.overview) return ts;
    if (!isYearly) return ts;
    const overviewRolled = rollupTimeseriesBlockYearEnd({
      points: ts.overview.points,
      lines: ts.overview.lines,
    });
    const patrimonioRolled = ts.patrimonio_usd_milestones_chart
      ? rollupTimeseriesBlockYearEnd(ts.patrimonio_usd_milestones_chart)
      : undefined;
    return {
      ...ts,
      accounts_ex_property: rollupTimeseriesBlockYearEnd(ts.accounts_ex_property),
      overview: { lines: ts.overview.lines, points: overviewRolled.points },
      ...(patrimonioRolled ? { patrimonio_usd_milestones_chart: patrimonioRolled } : {}),
    };
  }, [ts, isYearly]);

  const dataKeyToGroup = useMemo(() => {
    if (!dash) return {};
    const m: Record<string, string> = {};
    for (const a of dash.accounts) {
      m[String(a.account_id)] = a.group_slug;
    }
    m.stocks_total = "brokerage";
    m.stocks_total__dep = "brokerage";
    m.crypto_total = "brokerage";
    m.crypto_total__dep = "brokerage";
    m.mutual_funds_total = "brokerage";
    m.mutual_funds_total__dep = "brokerage";
    /** Synthetic keys from `mergeDashboardPrimaryAccountsBlock` (server `valuationTimeseries.ts`). */
    m["-9101"] = "retirement";
    m["-9101__dep"] = "retirement";
    m["-9102"] = "retirement";
    m["-9102__dep"] = "retirement";
    return m;
  }, [dash]);

  const primaryColorRgbByIndex = useMemo(() => {
    const lines = tsForCharts?.accounts_ex_property?.accounts;
    if (!lines?.length) return undefined;
    const m = new Map<number, string>();
    lines.forEach((line, i) => {
      if (line.color_rgb) m.set(i, line.color_rgb);
    });
    return m.size > 0 ? m : undefined;
  }, [tsForCharts]);

  const retirementBreakdown = useMemo(
    () => (dash ? buildRetirementCardBreakdown(dash.accounts) : []),
    [dash]
  );
  const brokerageBreakdown = useMemo(
    () => (dash ? buildBrokerageCardBreakdown(dash.accounts) : []),
    [dash]
  );
  const realEstateBreakdown = useMemo(
    () => (dash ? buildRealEstateCardBreakdown(dash.accounts, dash.suecia_snapshot) : []),
    [dash]
  );
  const cashBreakdown = useMemo(() => {
    if (!dash) return { lines: [], bottomLines: [] };
    const cc = dash.liabilities_breakdown;
    return buildCashCardBreakdown(
      dash.accounts,
      cc
        ? { clp: cc.credit_card_clp, usd: cc.credit_card_usd }
        : null
    );
  }, [dash]);

  const cashCardSlugs = useMemo(() => new Set(["fondo_reserva", "cuenta_corriente"]), []);

  const netWorthMetrics = useMemo(
    () => (dash ? cardGroupMetricsNetWorth(dash.accounts, metricsPeriod) : null),
    [dash, metricsPeriod]
  );
  const realEstateMetrics = useMemo(
    () => (dash ? cardGroupMetricsForGroup(dash.accounts, "real_estate", metricsPeriod) : null),
    [dash, metricsPeriod]
  );
  const retirementMetrics = useMemo(
    () => (dash ? cardGroupMetricsForGroup(dash.accounts, "retirement", metricsPeriod) : null),
    [dash, metricsPeriod]
  );
  const brokerageMetrics = useMemo(
    () => (dash ? cardGroupMetricsForGroup(dash.accounts, "brokerage", metricsPeriod) : null),
    [dash, metricsPeriod]
  );
  const cashMetrics = useMemo(
    () =>
      dash
        ? cardGroupMetricsForGroup(dash.accounts, "cash_eqs", metricsPeriod, (a) =>
            cashCardSlugs.has(a.category_slug)
          )
        : null,
    [dash, metricsPeriod, cashCardSlugs]
  );

  const overviewPoints = ts?.overview?.points ?? [];

  const netWorthTitleDelta = useMemo(
    () =>
      dash
        ? cardGroupNetWorthTitleBalanceDelta(
            dash.accounts,
            dash.totals,
            overviewPoints,
            metricsPeriod,
            showUsd
          )
        : null,
    [dash, overviewPoints, metricsPeriod, showUsd]
  );
  const realEstateTitleDelta = useMemo(
    () =>
      dash
        ? cardGroupTitleBalanceDelta(
            dash.accounts,
            dash.totals,
            overviewPoints,
            "real_estate",
            metricsPeriod,
            showUsd
          )
        : null,
    [dash, overviewPoints, metricsPeriod, showUsd]
  );
  const retirementTitleDelta = useMemo(
    () =>
      dash
        ? cardGroupTitleBalanceDelta(
            dash.accounts,
            dash.totals,
            overviewPoints,
            "retirement",
            metricsPeriod,
            showUsd
          )
        : null,
    [dash, overviewPoints, metricsPeriod, showUsd]
  );
  const brokerageTitleDelta = useMemo(
    () =>
      dash
        ? cardGroupTitleBalanceDelta(
            dash.accounts,
            dash.totals,
            overviewPoints,
            "brokerage",
            metricsPeriod,
            showUsd
          )
        : null,
    [dash, overviewPoints, metricsPeriod, showUsd]
  );
  const cashTitleDelta = useMemo(
    () =>
      dash
        ? cardGroupTitleBalanceDelta(
            dash.accounts,
            dash.totals,
            overviewPoints,
            "cash_eqs",
            metricsPeriod,
            showUsd,
            (a) => cashCardSlugs.has(a.category_slug)
          )
        : null,
    [dash, overviewPoints, metricsPeriod, showUsd, cashCardSlugs]
  );

  const dashboardBucketLayout = useMemo(() => {
    if (!dash) return DEFAULT_DASHBOARD_BUCKET_LAYOUT;
    const raw = (dash.dashboard_layout ?? []).filter((c) => DASHBOARD_KNOWN_BUCKETS.has(c.bucket_slug));
    const list = raw.length > 0 ? [...raw].sort((a, b) => a.sort_order - b.sort_order) : DEFAULT_DASHBOARD_BUCKET_LAYOUT;
    return list;
  }, [dash]);

  if (err) {
    return (
      <main>
        <p className="error">{err}</p>
      </main>
    );
  }

  if (!dash || !tsForCharts || !tsForCharts.accounts_ex_property || !tsForCharts.overview) {
    return null;
  }

  const fmtClp = (clp: number) => formatClp(clp);
  const fmtUsdPos = (usd: number | null | undefined) =>
    usd != null && Number.isFinite(usd) ? formatUsd(usd) : "—";
  /** USD only from API (per-account / per-event FX). No latest-rate fallback. */
  const fmtMoney = (clp: number, apiUsd?: number | null) => {
    if (showUsd) {
      return apiUsd != null && Number.isFinite(apiUsd) ? formatUsd(apiUsd) : "—";
    }
    return fmtClp(clp);
  };

  const useUsdPie =
    showUsd &&
    dash.allocation.some((a) => a.value_usd != null && Number.isFinite(a.value_usd) && a.value_usd > 0);

  const pieData = dash.allocation
    .filter((a) => a.group_slug !== "liabilities")
    .map((a) => ({
      name: a.group_label,
      value: useUsdPie && a.value_usd != null ? a.value_usd : a.value_clp,
      group_slug: a.group_slug,
    }));

  return (
    <main className="page-dashboard">
      <h1>{t("dashboard.title")}</h1>
      <PortfolioEntityCardsStrip
        compactSlot={
          <CompactEntityCard
            label={t("dashboard.cards.netWorth")}
            balanceDelta={netWorthTitleDelta}
            showUsd={showUsd}
            clp={dash.totals.net_worth_clp}
            apiUsd={dash.totals.net_worth_usd}
            cardSlug="net_worth"
            animated={!unitSwitching}
            stripInner
            valueVariant="main"
            metrics={
              netWorthMetrics ? (
                <DashboardCardGroupMetrics
                  metrics={netWorthMetrics}
                  showUsd={showUsd}
                  period={metricsPeriod}
                  cardSlug="net_worth"
                  animated={!unitSwitching}
                />
              ) : null
            }
          />
        }
        detailSlots={
          <>
            {dashboardBucketLayout.map((card) => {
            const bucket = card.bucket_slug;
            const cardTitle = card.label_i18n_key ? t(card.label_i18n_key) : card.label;
            const cashClass = card.card_css === "cash" ? "card--cash" : "";

            if (bucket === "real_estate") {
              return (
                <DetailedGroupCard
                  key={card.slug}
                  title={cardTitle}
                  balanceDelta={realEstateTitleDelta}
                  showUsd={showUsd}
                  clp={dash.totals.real_estate_clp}
                  apiUsd={dash.totals.real_estate_usd}
                  cardSlug="real_estate"
                  animated={!unitSwitching}
                  className={cashClass}
                  metrics={
                    realEstateMetrics ? (
                      <DashboardCardGroupMetrics
                        metrics={realEstateMetrics}
                        showUsd={showUsd}
                        period={metricsPeriod}
                        cardSlug="real_estate"
                        animated={!unitSwitching}
                      />
                    ) : null
                  }
                  breakdown={
                    <DashboardCardBreakdown
                      lines={realEstateBreakdown}
                      showUsd={showUsd}
                      cardSlug="real_estate"
                      animated={!unitSwitching}
                    />
                  }
                />
              );
            }
            if (bucket === "retirement") {
              return (
                <DetailedGroupCard
                  key={card.slug}
                  title={cardTitle}
                  balanceDelta={retirementTitleDelta}
                  showUsd={showUsd}
                  clp={dash.totals.retirement_clp}
                  apiUsd={dash.totals.retirement_usd}
                  cardSlug="retirement"
                  animated={!unitSwitching}
                  className={cashClass}
                  metrics={
                    retirementMetrics ? (
                      <DashboardCardGroupMetrics
                        metrics={retirementMetrics}
                        showUsd={showUsd}
                        period={metricsPeriod}
                        cardSlug="retirement"
                        animated={!unitSwitching}
                      />
                    ) : null
                  }
                  breakdown={
                    <DashboardCardBreakdown
                      lines={retirementBreakdown}
                      showUsd={showUsd}
                      cardSlug="retirement"
                      animated={!unitSwitching}
                    />
                  }
                />
              );
            }
            if (bucket === "brokerage") {
              return (
                <DetailedGroupCard
                  key={card.slug}
                  title={cardTitle}
                  balanceDelta={brokerageTitleDelta}
                  showUsd={showUsd}
                  clp={dash.totals.brokerage_clp}
                  apiUsd={dash.totals.brokerage_usd}
                  cardSlug="brokerage"
                  animated={!unitSwitching}
                  className={cashClass}
                  metrics={
                    brokerageMetrics ? (
                      <DashboardCardGroupMetrics
                        metrics={brokerageMetrics}
                        showUsd={showUsd}
                        period={metricsPeriod}
                        cardSlug="brokerage"
                        animated={!unitSwitching}
                      />
                    ) : null
                  }
                  breakdown={
                    <DashboardCardBreakdown
                      lines={brokerageBreakdown}
                      showUsd={showUsd}
                      cardSlug="brokerage"
                      animated={!unitSwitching}
                    />
                  }
                />
              );
            }
            if (bucket === "cash_eqs") {
              return (
                <DetailedGroupCard
                  key={card.slug}
                  title={cardTitle}
                  balanceDelta={cashTitleDelta}
                  showUsd={showUsd}
                  clp={dash.totals.cash_eqs_clp}
                  apiUsd={dash.totals.cash_eqs_usd}
                  cardSlug="cash_eqs"
                  animated={!unitSwitching}
                  className={cashClass}
                  metrics={
                    cashMetrics ? (
                      <DashboardCardGroupMetrics
                        metrics={cashMetrics}
                        showUsd={showUsd}
                        period={metricsPeriod}
                        cardSlug="cash_eqs"
                        animated={!unitSwitching}
                      />
                    ) : null
                  }
                  breakdown={
                    <DashboardCardBreakdown
                      lines={cashBreakdown.lines}
                      bottomLines={cashBreakdown.bottomLines}
                      pinBottomToCard
                      showUsd={showUsd}
                      cardSlug="cash_eqs"
                      animated={!unitSwitching}
                    />
                  }
                />
              );
            }
            return null;
          })}
          </>
        }
      />

      <ValuationLineCharts
        displayUnit={displayUnit}
        primaryTitle={t("dashboard.sections.primaryAccountsTitle")}
        primary={tsForCharts.accounts_ex_property}
        secondaryTitle={t("dashboard.sections.overviewTitle")}
        secondary={{ lines: tsForCharts.overview.lines, points: tsForCharts.overview.points }}
        thickLineDataKey="total_nw"
        includeAccumulatedLines={false}
        primaryColorPlan={{
          kind: "dashboard-primary",
          dataKeyToGroup,
          colorRgbByColorIndex: primaryColorRgbByIndex,
        }}
        secondaryColorPlan={{ kind: "dashboard-overview" }}
        xAxisGranularity={xAxisGranularity}
        chartLayout="fullWidthStack"
      />

      {tsForCharts.patrimonio_usd_milestones_chart?.points.length ? (
        <>
          <h2 style={{ marginTop: "1.75rem" }}>{t("dashboard.sections.netWorthUsdSectionTitle")}</h2>
          <p className="muted" style={{ fontSize: "0.85rem", marginBottom: "0.5rem", maxWidth: "58rem" }}>
            {t("dashboard.sections.netWorthUsdSectionHint")}
          </p>
          <div className="chart-grid chart-grid--full-line">
            <LineChartPanel
              title={t("dashboard.sections.netWorthUsdChartTitle")}
              titleAs="h3"
              block={tsForCharts.patrimonio_usd_milestones_chart}
              displayUnit="clp"
              includeAccumulatedLines={false}
              trimLeadingInactive={false}
              colorPlan={{ kind: "dashboard-patrimonio-usd" }}
              thickKey="total_nw"
              xAxisGranularity={xAxisGranularity}
              yScaleDataKeys={["total_nw", "invested"]}
            />
          </div>
        </>
      ) : null}

      {retirementBrokerageForCharts.length > 0 ? (
        <>
          <h2 style={{ marginTop: "1.75rem" }}>
            {isYearly ? t("dashboard.sections.perfSectionTitleYearly") : t("dashboard.sections.perfSectionTitleMonthly")}
          </h2>
          <p className="muted" style={{ fontSize: "0.85rem", marginBottom: "0.5rem", maxWidth: "58rem" }}>
            {isYearly ? t("dashboard.sections.perfSectionHintYearly") : t("dashboard.sections.perfSectionHintMonthly")}
          </p>
          <div className="chart-grid chart-grid--full-line">
            <MonthlyPerformanceComboChart
              title={
                isYearly ? t("dashboard.sections.perfChartTitleYearly") : t("dashboard.sections.perfChartTitleMonthly")
              }
              titleAs="h3"
              points={retirementBrokerageForCharts}
              displayUnit={displayUnit}
              xAxisGranularity={xAxisGranularity}
              barSeries={[
                {
                  dataKey: "delta_retirement",
                  name: isYearly
                    ? t("dashboard.sections.deltaRetirementYearly")
                    : t("dashboard.sections.deltaRetirementMonthly"),
                  color: allocationBucketColor("retirement"),
                },
                {
                  dataKey: "delta_brokerage",
                  name: isYearly
                    ? t("dashboard.sections.deltaBrokerageYearly")
                    : t("dashboard.sections.deltaBrokerageMonthly"),
                  color: allocationBucketColor("brokerage"),
                },
              ]}
              areaKey="ytd_combined"
              areaName={isYearly ? t("dashboard.sections.yearTotalCombined") : t("dashboard.sections.ytdCombined")}
              areaFill="rgba(148, 163, 184, 0.22)"
              areaStroke="#64748b"
              lineKey="delta_combined"
              lineName={isYearly ? t("dashboard.combinedAnnualDelta") : t("dashboard.combinedMonthlyDelta")}
            />
          </div>
          <h2 style={{ marginTop: "1.75rem" }}>
            {isYearly ? t("dashboard.sections.accumSectionTitleYearly") : t("dashboard.sections.accumSectionTitleMonthly")}
          </h2>
          <p className="muted" style={{ fontSize: "0.85rem", marginBottom: "0.5rem", maxWidth: "58rem" }}>
            {isYearly ? t("dashboard.sections.accumSectionHintYearly") : t("dashboard.sections.accumSectionHintMonthly")}
          </p>
          <div className="chart-grid chart-grid--full-line">
            <MonthlyPerformanceComboChart
              title={
                isYearly ? t("dashboard.sections.accumChartTitleYearly") : t("dashboard.sections.accumChartTitleMonthly")
              }
              titleAs="h3"
              points={retirementBrokerageAccumChart}
              displayUnit={displayUnit}
              xAxisGranularity={xAxisGranularity}
              barSeries={[
                {
                  dataKey: "delta_combined",
                  name: isYearly
                    ? t("dashboard.sections.deltaCombinedYearly")
                    : t("dashboard.sections.deltaCombinedMonthly"),
                  color: "#38bdf8",
                },
                {
                  dataKey: "deposits_inversiones",
                  name: isYearly
                    ? t("dashboard.sections.depositsInversionesYearly")
                    : t("dashboard.sections.depositsInversionesMonthly"),
                  color: "#a78bfa",
                },
              ]}
              areaKey="accumulated_earnings"
              areaName={t("dashboard.sections.accumulatedEarnings")}
              areaFill="rgba(148, 163, 184, 0.22)"
              areaStroke="#64748b"
              alternateYearAreaStripes={false}
              lineSeries={[
                {
                  dataKey: "delta_combined_ma3",
                  name: isYearly
                    ? t("dashboard.sections.ma3DeltaCombinedYearly")
                    : t("dashboard.sections.ma3DeltaCombinedMonthly"),
                  stroke: "#38bdf8",
                  strokeWidth: 1.5,
                  showDot: false,
                },
                {
                  dataKey: "deposits_inversiones_ma3",
                  name: isYearly
                    ? t("dashboard.sections.ma3DepositsInversionesYearly")
                    : t("dashboard.sections.ma3DepositsInversionesMonthly"),
                  stroke: "#a78bfa",
                  strokeWidth: 1.5,
                  showDot: false,
                },
              ]}
            />
          </div>
        </>
      ) : null}

      <h2>{t("dashboard.allocation.title")}</h2>
      {pieData.length === 0 ? (
        <p className="empty">{t("dashboard.allocation.empty")}</p>
      ) : (
        <div className="chart-box">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart margin={{ top: 32, right: 4, left: 4, bottom: 0 }}>
              <Pie
                data={pieData}
                dataKey="value"
                nameKey="name"
                cx="50%"
                cy="50%"
                outerRadius={100}
                label={(p: { value?: unknown }) => {
                  const v = typeof p.value === "number" ? p.value : Number(p.value);
                  return formatMoneyForPie(Number.isFinite(v) ? v : 0, useUsdPie ? "usd" : "clp");
                }}
                isAnimationActive
                animationBegin={0}
                animationDuration={90}
                animationEasing="ease-out"
              >
                {pieData.map((row, i) => (
                  <Cell key={i} fill={allocationBucketColor(row.group_slug)} />
                ))}
              </Pie>
              <Tooltip
                formatter={(v: number) => formatMoneyForPie(v, useUsdPie ? "usd" : "clp")}
              />
              <Legend formatter={(value) => String(value ?? "")} />
            </PieChart>
          </ResponsiveContainer>
        </div>
      )}

      <h2>Accounts</h2>
      <Table
        header={
          <thead>
            <tr>
              <th>Account</th>
              <th>Class</th>
              <th>Category</th>
              <th>Ticker</th>
              <th>Cuotas</th>
              <th>Net inflow</th>
              <th>Current value</th>
              <th>CLP / unit</th>
              <th>As of</th>
            </tr>
          </thead>
        }
      >
        {dash.accounts.length === 0 ? (
          <tr>
            <td colSpan={9} className="muted">
              No accounts yet. Open an asset tab and note category IDs for{" "}
              <span className="mono">POST /api/accounts</span>.
            </td>
          </tr>
        ) : (
          dash.accounts.map((a) => (
            <tr key={a.account_id}>
              <td>
                <Link to={`/account/${a.account_id}`}>{a.name}</Link>
              </td>
              <td>{a.group_label}</td>
              <td>{a.category_label}</td>
              <td className="mono">{a.position?.ticker ?? "—"}</td>
              <td className="mono">
                {a.position?.units != null && Number.isFinite(a.position.units)
                  ? formatInstrumentUnits(a.position.units, a.position.units_kind)
                  : "—"}
              </td>
              <td className="mono">{fmtMoney(a.deposits_clp)}</td>
              <td className="mono">
                {showUsd
                  ? fmtUsdPos(a.current_value_usd ?? null)
                  : a.current_value_clp != null
                    ? fmtClp(a.current_value_clp)
                    : "—"}
              </td>
              <td className="mono">
                {a.position?.value_per_unit_clp != null
                  ? fmtClp(a.position.value_per_unit_clp)
                  : "—"}
              </td>
              <td className="muted">{a.valuation_as_of ?? "—"}</td>
            </tr>
          ))
        )}
      </Table>
    </main>
  );
}
