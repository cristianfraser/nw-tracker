import type { ReactNode } from "react";
import {
  AllocationPiePanel,
  LineChartPanel,
  type ChartDisplayUnit,
} from "./ValuationLineCharts";
import { MonthlyPerformanceComboChart } from "./MonthlyPerformanceComboChart";
import { groupTabPieSliceFill } from "../../chartColors";
import { cn } from "../../cn";
import i18n from "../../i18n";
import type { GroupTabColorMaps, PortfolioGroupChartsColorSlug } from "../../usePortfolioGroupCharts";
import type { GroupPageChartContext } from "../../groupPageChartViews";
import type { TimeseriesBlock } from "../../types";

type PerfBarSeries = {
  dataKey: string;
  name: string;
  color: string;
};

type PieSlice = { name: string; account_id: number; value: number };

export function PortfolioGroupChartsSection({
  accountsEmpty,
  accountsEmptyMessage,
  chartSeriesCount,
  valuationBlockForChart,
  displayPieSlices,
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
}: {
  accountsEmpty: boolean;
  accountsEmptyMessage: string;
  chartSeriesCount: number;
  valuationBlockForChart: TimeseriesBlock | null;
  displayPieSlices: PieSlice[];
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
}) {
  if (accountsEmpty) {
    return (
      <p className="empty muted" style={{ marginTop: "1rem" }}>
        {accountsEmptyMessage}
      </p>
    );
  }

  if (!valuationBlockForChart) return null;

  const includeDeposits = chartCtx?.showGroupedToggle ? showValuationDeposits : true;

  return (
    <>
      <div
        className={cn("chart-grid", chartSeriesCount <= 1 && "chart-grid--full-line")}
        style={{ marginTop: "0.75rem" }}
      >
        <LineChartPanel
          title={i18n.t("charts.valuationAndDeposits")}
          block={valuationBlockForChart}
          displayUnit={displayUnit}
          xAxisGranularity={xAxisGranularity}
          includeAccumulatedLines={includeDeposits}
          colorPlan={{
            kind: "group-tab",
            groupSlug:
              chartColorSlug === "liabilities"
                ? ("liabilities" as typeof colorPlanGroupSlug)
                : colorPlanGroupSlug,
            brokerageSubgroup: chartCtx?.brokerageSubgroup,
            accounts: valuationBlockForChart.accounts ?? [],
            groupTotalColorRgb: groupColorRgb,
          }}
          thickKey={
            valuationBlockForChart.accounts?.some((a) => a.dataKey === "__group_val_total")
              ? "__group_val_total"
              : undefined
          }
        />
        {chartSeriesCount > 1 && (
          <AllocationPiePanel
            title={i18n.t("charts.currentValueByAccount")}
            slices={displayPieSlices}
            displayUnit={displayUnit}
            sliceFill={(slice) =>
              groupTabPieSliceFill(chartColorSlug, groupColorMaps, slice.account_id, {
                allocationBucketSlug: pieAllocationSlug,
              })
            }
          />
        )}
      </div>

      {chartControls}

      {!hideGroupPerf &&
      groupPerfForChart &&
      groupPerfForChart.points.length > 0 &&
      groupPerfBarSeries.length > 0 ? (
        <>
          <h2 style={{ marginTop: "1.75rem", fontSize: "1.15rem" }}>{i18n.t("charts.groupPerfTitle")}</h2>
          <p
            className="muted"
            style={{ fontSize: "0.85rem", marginBottom: "0.5rem", maxWidth: "58rem" }}
          >
            {i18n.t("charts.groupPerfHint")}
          </p>
          <div className="chart-grid chart-grid--full-line">
            <MonthlyPerformanceComboChart
              title={i18n.t("charts.groupPerfComboTitle")}
              points={groupPerfForChart.points}
              displayUnit={displayUnit}
              xAxisGranularity={xAxisGranularity}
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
            />
          </div>
          <h2 style={{ marginTop: "1.75rem", fontSize: "1.15rem" }}>{i18n.t("charts.groupAccumTitle")}</h2>
          <p
            className="muted"
            style={{ fontSize: "0.85rem", marginBottom: "0.5rem", maxWidth: "58rem" }}
          >
            {i18n.t("charts.groupAccumHint")}
          </p>
          <div className="chart-grid chart-grid--full-line">
            <MonthlyPerformanceComboChart
              title={i18n.t("charts.monthlyDeltaConsolidatedAccumTitle")}
              points={groupPerfForChart.points}
              displayUnit={displayUnit}
              xAxisGranularity={xAxisGranularity}
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
            />
          </div>
        </>
      ) : null}
    </>
  );
}
