import type { ReactNode } from "react";
import { LineChartPanel, MonthlyPerformanceComboChart } from "./lazyCharts";
import type { ChartDisplayUnit } from "./chartLayout";
import i18n from "../../i18n";
import type { PortfolioGroupChartsColorSlug } from "../../usePortfolioGroupCharts";
import type { GroupPageChartContext } from "../../groupPageChartViews";
import type { TimeRange } from "../../timeRange";
import type { TimeseriesBlock } from "../../types";

type PerfBarSeries = {
  dataKey: string;
  name: string;
  color: string;
};

/** The valuation chart's frame when the page has no block yet (cold nav: no node to chart). */
export const EMPTY_VALUATION_BLOCK: TimeseriesBlock = { accounts: [], points: [] };

/** A group's «Valorización y aportes» chart (the group page's, and the basket page's band). */
export function GroupValuationChart({
  title,
  block,
  displayUnit,
  xAxisGranularity,
  timeRange,
  controls,
  includeAccumulatedLines,
  chartColorSlug,
  colorPlanGroupSlug,
  chartCtx,
  groupColorRgb,
  hideLegend = false,
  loading = false,
}: {
  /** Default «Valorización y aportes» (a cash group: «Saldo»). */
  title?: string;
  block: TimeseriesBlock;
  displayUnit: ChartDisplayUnit;
  xAxisGranularity: "month" | "year" | "day";
  timeRange?: TimeRange;
  controls?: ReactNode;
  includeAccumulatedLines: boolean;
  chartColorSlug: PortfolioGroupChartsColorSlug;
  colorPlanGroupSlug: GroupPageChartContext["colorPlanGroupSlug"];
  chartCtx: GroupPageChartContext | null;
  groupColorRgb?: string | null;
  /** No legend under the plot (the basket page, as the position page). */
  hideLegend?: boolean;
  loading?: boolean;
}) {
  return (
    <LineChartPanel
      title={title ?? i18n.t("charts.valuationAndDeposits")}
      block={block}
      displayUnit={displayUnit}
      xAxisGranularity={xAxisGranularity}
      timeRange={timeRange}
      controls={controls}
      includeAccumulatedLines={includeAccumulatedLines}
      colorPlan={{
        kind: "group-tab",
        groupSlug:
          chartColorSlug === "liabilities"
            ? ("liabilities" as typeof colorPlanGroupSlug)
            : colorPlanGroupSlug,
        brokerageSubgroup: chartCtx?.brokerageSubgroup,
        accounts: block.accounts ?? [],
        groupTotalColorRgb: groupColorRgb,
      }}
      thickKey={block.accounts?.some((a) => a.dataKey === "__group_val_total") ? "__group_val_total" : undefined}
      hideLegend={hideLegend}
      loading={loading}
    />
  );
}

/** A group's P/L combo: the members' period P/L bars, the group's running YTD and its total Δ. */
export function GroupPlCombo({
  title,
  titleAs,
  points,
  displayUnit,
  xAxisGranularity,
  timeRange,
  controls,
  barSeries,
  groupTotalStroke,
  hideLegend = false,
  loading = false,
}: {
  /** Default «P/L por cuenta / subgrupo, YTD combinado y Δ total». */
  title?: string;
  titleAs?: "h2" | "h3";
  points: Record<string, string | number | null>[];
  displayUnit: ChartDisplayUnit;
  xAxisGranularity: "month" | "year" | "day";
  timeRange?: TimeRange;
  controls?: ReactNode;
  barSeries: PerfBarSeries[];
  groupTotalStroke: string;
  /** No legend under the plot (the investment pages). */
  hideLegend?: boolean;
  loading?: boolean;
}) {
  return (
    <MonthlyPerformanceComboChart
      title={title ?? i18n.t("charts.groupPerfComboTitle")}
      titleAs={titleAs}
      points={points}
      displayUnit={displayUnit}
      xAxisGranularity={xAxisGranularity}
      timeRange={timeRange}
      controls={controls}
      barSeries={barSeries}
      areaKey="ytd_group"
      areaName={i18n.t("charts.ytdGroupSeries")}
      areaFill="rgba(148, 163, 184, 0.22)"
      areaStroke="#64748b"
      lineSeries={[
        {
          dataKey: "delta_total",
          name: i18n.t("charts.deltaTotalSeries"),
          stroke: groupTotalStroke,
          showDot: true,
        },
      ]}
      hideLegend={hideLegend}
      loading={loading}
    />
  );
}
