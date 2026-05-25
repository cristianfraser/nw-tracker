import { useMemo } from "react";
import { buildGroupTabColorMaps, groupTabTotalStroke } from "./chartColors";

export type GroupTabColorMaps = {
  byDataKey: Map<string, string>;
  byAccountId: Map<number, string>;
};
import { rollupPerfPointsYearly, rollupTimeseriesBlockYearEnd } from "./dashboardTimeseriesYearly";
import type {
  AssetGroupSlug,
  GroupMonthlyPerformanceResponse,
  TimeseriesBlock,
} from "./types";

export type PortfolioGroupChartsColorSlug = AssetGroupSlug | "crypto" | "liabilities";

export function usePortfolioGroupCharts(opts: {
  displayValuationBlock: TimeseriesBlock | null;
  displayGroupPerf: GroupMonthlyPerformanceResponse | null;
  isYearly: boolean;
  chartColorSlug: PortfolioGroupChartsColorSlug;
  pieAllocationSlug: PortfolioGroupChartsColorSlug;
  colorPlanGroupSlug: "inversiones" | "brokerage" | "retirement";
  /** Nav node `color_rgb` for this group page (Total line / consolidated Δ). */
  groupColorRgb?: string | null;
  /** Nav `portfolio_groups.slug` (e.g. `brokerage_acciones`) for color fallback. */
  navGroupSlug?: string;
}) {
  const {
    displayValuationBlock,
    displayGroupPerf,
    isYearly,
    chartColorSlug,
    pieAllocationSlug,
    colorPlanGroupSlug,
    groupColorRgb,
    navGroupSlug,
  } = opts;

  const valuationBlockForChart = useMemo(() => {
    if (!displayValuationBlock) return null;
    if (!isYearly) return displayValuationBlock;
    return rollupTimeseriesBlockYearEnd(displayValuationBlock);
  }, [displayValuationBlock, isYearly]);

  const groupPerfForChart = useMemo(() => {
    if (!displayGroupPerf?.points.length) return displayGroupPerf;
    if (!isYearly) return displayGroupPerf;
    const barKeys = displayGroupPerf.bar_accounts.map((a) => a.bar_data_key);
    return {
      ...displayGroupPerf,
      points: rollupPerfPointsYearly(displayGroupPerf.points, {
        sumKeys: barKeys,
        ytdKey: "ytd_group",
        accumKey: "accumulated_earnings",
        totalKey: "delta_total",
      }),
    };
  }, [displayGroupPerf, isYearly]);

  const groupColorMaps: GroupTabColorMaps = useMemo(() => {
    const accLines = displayValuationBlock?.accounts;
    if (!accLines?.length) {
      return { byDataKey: new Map<string, string>(), byAccountId: new Map<number, string>() };
    }
    return buildGroupTabColorMaps(chartColorSlug, accLines, groupColorRgb);
  }, [chartColorSlug, displayValuationBlock, groupColorRgb]);

  const groupPerfBarSeries = useMemo(() => {
    if (!displayGroupPerf?.bar_accounts.length) return [];
    const lines = displayGroupPerf.bar_accounts.map((a) => ({
      account_id: a.account_id,
      name: a.name,
      dataKey: a.bar_data_key,
      color_rgb: a.color_rgb,
    }));
    const maps = buildGroupTabColorMaps(chartColorSlug, lines, groupColorRgb);
    return displayGroupPerf.bar_accounts.map((a) => ({
      dataKey: a.bar_data_key,
      name: `Δ ${a.name}`,
      color:
        groupColorMaps.byAccountId.get(a.account_id) ??
        maps.byDataKey.get(a.bar_data_key) ??
        "#60a5fa",
    }));
  }, [chartColorSlug, displayGroupPerf, groupColorMaps, groupColorRgb]);

  const groupTotalStroke = useMemo(
    () => groupTabTotalStroke(groupColorRgb, navGroupSlug ?? pieAllocationSlug),
    [groupColorRgb, navGroupSlug, pieAllocationSlug]
  );

  return {
    valuationBlockForChart,
    groupPerfForChart,
    groupColorMaps,
    groupPerfBarSeries,
    groupTotalStroke,
    colorPlanGroupSlug,
    chartColorSlug,
    pieAllocationSlug,
  };
}
