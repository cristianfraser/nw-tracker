import { useMemo } from "react";
import { allocationBucketColor, buildGroupTabColorMaps } from "./chartColors";

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
}) {
  const {
    displayValuationBlock,
    displayGroupPerf,
    isYearly,
    chartColorSlug,
    pieAllocationSlug,
    colorPlanGroupSlug,
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
    return buildGroupTabColorMaps(chartColorSlug, accLines);
  }, [chartColorSlug, displayValuationBlock]);

  const groupPerfBarSeries = useMemo(() => {
    if (!displayGroupPerf?.bar_accounts.length) return [];
    const lines = displayGroupPerf.bar_accounts.map((a) => ({
      account_id: a.account_id,
      name: a.name,
      dataKey: a.bar_data_key,
      color_rgb: a.color_rgb,
    }));
    const maps = buildGroupTabColorMaps(chartColorSlug, lines);
    return displayGroupPerf.bar_accounts.map((a) => ({
      dataKey: a.bar_data_key,
      name: `Δ ${a.name}`,
      color:
        groupColorMaps.byAccountId.get(a.account_id) ??
        maps.byDataKey.get(a.bar_data_key) ??
        "#60a5fa",
    }));
  }, [chartColorSlug, displayGroupPerf, groupColorMaps]);

  const consolidatedBarColor = allocationBucketColor(pieAllocationSlug as AssetGroupSlug);

  return {
    valuationBlockForChart,
    groupPerfForChart,
    groupColorMaps,
    groupPerfBarSeries,
    consolidatedBarColor,
    colorPlanGroupSlug,
    chartColorSlug,
    pieAllocationSlug,
  };
}
