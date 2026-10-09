import type { ReactNode } from "react";
import { LineChartPanel, MonthlyPerformanceComboChart, ProportionalAreaChart } from "./lazyCharts";
import type { ChartDisplayUnit } from "./chartLayout";
import { groupTabPieSliceFill } from "../../chartColors";
import { cn } from "../../cn";
import i18n from "../../i18n";
import type { GroupTabColorMaps, PortfolioGroupChartsColorSlug } from "../../usePortfolioGroupCharts";
import type { GroupPageChartContext } from "../../groupPageChartViews";
import type { TimeRange } from "../../timeRange";
import type { ProportionalSeriesBlockDto, TimeseriesBlock } from "../../types";

type PerfBarSeries = {
  dataKey: string;
  name: string;
  color: string;
};

/** The valuation chart's frame when the page has no block yet (cold nav: no node to chart). */
const EMPTY_VALUATION_BLOCK: TimeseriesBlock = { accounts: [], points: [] };

export function PortfolioGroupChartsSection({
  accountsEmpty,
  accountsEmptyMessage,
  chartSeriesCount,
  valuationBlockForChart,
  proportionalBlock,
  proportionalXAxisGranularity = "month",
  proportionalTimeRange,
  proportionalControls,
  proportionalReplacement,
  displayUnit,
  xAxisGranularity,
  chartColorSlug,
  pieAllocationSlug,
  colorPlanGroupSlug,
  groupColorMaps,
  groupPerfForChart,
  groupPerfBarSeries,
  groupTotalStroke,
  groupColorRgb,
  chartCtx,
  showValuationDeposits = true,
  chartControls,
  hideGroupPerf = false,
  valuationXAxisGranularity,
  perfXAxisGranularity,
  valuationTimeRange,
  perfTimeRange,
  valuationControls,
  perfControls,
  loading = false,
  valuationLoading = loading,
  proportionalLoading = loading,
  perfLoading = loading,
}: {
  accountsEmpty: boolean;
  accountsEmptyMessage: string;
  chartSeriesCount: number;
  valuationBlockForChart: TimeseriesBlock | null;
  /** Composition-share block (pie replacement); rendered beside the valuation chart. */
  proportionalBlock: ProportionalSeriesBlockDto | null;
  proportionalXAxisGranularity?: "day" | "month" | "year";
  proportionalTimeRange?: TimeRange;
  proportionalControls?: ReactNode;
  /** Drawn in the composition chart's place (Pasivos: the mortgage coverage chart). */
  proportionalReplacement?: ReactNode;
  displayUnit: ChartDisplayUnit;
  xAxisGranularity: "month" | "year";
  chartColorSlug: PortfolioGroupChartsColorSlug;
  pieAllocationSlug: PortfolioGroupChartsColorSlug;
  colorPlanGroupSlug: GroupPageChartContext["colorPlanGroupSlug"];
  groupColorMaps: GroupTabColorMaps;
  groupPerfForChart: { points: Record<string, string | number | null>[] } | null;
  groupPerfBarSeries: PerfBarSeries[];
  groupTotalStroke: string;
  groupColorRgb?: string | null;
  chartCtx: GroupPageChartContext | null;
  showValuationDeposits?: boolean;
  /** Rendered below the valuation/pie charts and above monthly P/L (e.g. Agrupado / Aportes acumulados). */
  chartControls?: ReactNode;
  /** Omit investment-style group P/L charts (pasivos routes). */
  hideGroupPerf?: boolean;
  /** Valuation-panel-only override (daily series). */
  valuationXAxisGranularity?: "month" | "year" | "day";
  /** P/L-combo override (daily per-account P/L bars + anchored cumulative areas). */
  perfXAxisGranularity?: "month" | "year" | "day";
  /** Per-surface ranges (fall back to the global toolbar range when omitted). */
  valuationTimeRange?: TimeRange;
  perfTimeRange?: TimeRange;
  /** Per-surface Período/Rango controls (the two P/L combos share `perfControls`). */
  valuationControls?: ReactNode;
  perfControls?: ReactNode;
  /**
   * The page bundle is a placeholder or held prior data: every chart dims, an empty account
   * list is not read as «no accounts» yet, and the P/L combos stay mounted.
   */
  loading?: boolean;
  /** Per-chart overrides (a Diario series still loading); default `loading`. */
  valuationLoading?: boolean;
  proportionalLoading?: boolean;
  perfLoading?: boolean;
}) {
  if (accountsEmpty && !loading) {
    return (
      <p className="empty muted" style={{ marginTop: "1rem" }}>
        {accountsEmptyMessage}
      </p>
    );
  }

  const valuationBlock = valuationBlockForChart ?? EMPTY_VALUATION_BLOCK;
  // Only the loaded bundle can say the group has no P/L; a placeholder keeps the combos' frames.
  const perfAbsent =
    !loading && (!groupPerfForChart?.points.length || groupPerfBarSeries.length === 0);
  const includeDeposits = chartCtx?.showGroupedToggle ? showValuationDeposits : true;

  return (
    <>
      <div
        className={cn("chart-grid", chartSeriesCount <= 1 && "chart-grid--full-line")}
        style={{ marginTop: "0.75rem" }}
      >
        <LineChartPanel
          title={i18n.t("charts.valuationAndDeposits")}
          block={valuationBlock}
          displayUnit={displayUnit}
          xAxisGranularity={valuationXAxisGranularity ?? xAxisGranularity}
          timeRange={valuationTimeRange}
          controls={valuationControls}
          includeAccumulatedLines={includeDeposits}
          colorPlan={{
            kind: "group-tab",
            groupSlug:
              chartColorSlug === "liabilities"
                ? ("liabilities" as typeof colorPlanGroupSlug)
                : colorPlanGroupSlug,
            brokerageSubgroup: chartCtx?.brokerageSubgroup,
            accounts: valuationBlock.accounts ?? [],
            groupTotalColorRgb: groupColorRgb,
          }}
          thickKey={
            valuationBlock.accounts?.some((a) => a.dataKey === "__group_val_total")
              ? "__group_val_total"
              : undefined
          }
          loading={valuationLoading}
        />
        {proportionalReplacement ??
          (chartSeriesCount > 1 && (
            <ProportionalAreaChart
              title={i18n.t("charts.currentValueByAccount")}
              block={proportionalBlock}
              xAxisGranularity={proportionalXAxisGranularity}
              timeRange={proportionalTimeRange}
              controls={proportionalControls}
              loading={proportionalLoading}
              colorFor={(line) =>
                groupTabPieSliceFill(
                  chartColorSlug,
                  groupColorMaps,
                  line.account_id ?? Number(line.dataKey),
                  { allocationBucketSlug: pieAllocationSlug }
                )
              }
            />
          ))}
      </div>

      {chartControls}

      {!hideGroupPerf && !perfAbsent ? (
        <>
          <div className="chart-grid chart-grid--full-line" style={{ marginTop: "1.75rem" }}>
            <MonthlyPerformanceComboChart
              title={i18n.t("charts.groupPerfComboTitle")}
              points={groupPerfForChart?.points ?? []}
              displayUnit={displayUnit}
              xAxisGranularity={perfXAxisGranularity ?? xAxisGranularity}
              timeRange={perfTimeRange}
              controls={perfControls}
              barSeries={groupPerfBarSeries}
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
              loading={perfLoading}
            />
          </div>
          <div className="chart-grid chart-grid--full-line" style={{ marginTop: "1.75rem" }}>
            <MonthlyPerformanceComboChart
              title={i18n.t("charts.monthlyDeltaConsolidatedAccumTitle")}
              points={groupPerfForChart?.points ?? []}
              displayUnit={displayUnit}
              xAxisGranularity={perfXAxisGranularity ?? xAxisGranularity}
              timeRange={perfTimeRange}
              controls={perfControls}
              barSeries={[
                {
                  dataKey: "delta_total",
                  name: i18n.t("charts.monthlyDeltaConsolidated"),
                  color: groupTotalStroke,
                },
              ]}
              areaKey="accumulated_earnings"
              areaName={i18n.t("dashboard.sections.accumulatedEarnings")}
              areaFill="rgba(148, 163, 184, 0.22)"
              areaStroke="#64748b"
              alternateYearAreaStripes={false}
              loading={perfLoading}
            />
          </div>
        </>
      ) : null}
    </>
  );
}
