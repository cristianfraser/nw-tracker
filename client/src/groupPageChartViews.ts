import type {
  GroupAllocationPieSlice,
  GroupMonthlyPerformanceResponse,
  NavTreeNodeDto,
  ValuationTimeseriesResponse,
} from "./types";

export type GroupPageChartContext = {
  showGroupedToggle: boolean;
  liabilitiesGrouped: boolean;
  chartColorSlug: string;
  pieAllocationSlug: string;
  colorPlanGroupSlug: "inversiones" | "brokerage" | "retirement";
  brokerageSubgroup?: "acciones" | "mutual_funds" | "crypto";
};

/**
 * Chart context for a group page. The "Agrupado" toggle and Pasivos grouping now follow the
 * SERVER payload: the grouped bucket blocks/pies/bars are computed server-side (see
 * server/src/groupChartBuckets.ts) from unclipped data, so the client only picks which precomputed
 * block to display — it never re-aggregates already-clipped series (which corrupted grouped totals).
 */
export function resolveGroupPageChartContext(
  navNode: NavTreeNodeDto,
  ts?: ValuationTimeseriesResponse | null
): GroupPageChartContext {
  const sub = navNode.api_subgroup ?? undefined;
  const apiGroup = navNode.api_group ?? "";

  const liabilitiesGrouped = Boolean(ts?.liab_grouped_block);
  const showGroupedToggle = Boolean(
    ts?.nav_grouped_blocks?.grouped || ts?.nav_grouped_blocks?.ungrouped
  );

  const chartColorSlug =
    apiGroup === "brokerage" && sub === "crypto" ? "crypto" : apiGroup || "inversiones";
  const pieAllocationSlug = chartColorSlug;

  const colorPlanGroupSlug: GroupPageChartContext["colorPlanGroupSlug"] =
    apiGroup === "inversiones"
      ? "inversiones"
      : apiGroup === "brokerage"
        ? "brokerage"
        : "retirement";

  const brokerageSubgroup =
    apiGroup === "brokerage" &&
    (sub === "acciones" || sub === "mutual_funds" || sub === "crypto")
      ? sub
      : undefined;

  return {
    showGroupedToggle,
    liabilitiesGrouped,
    chartColorSlug,
    pieAllocationSlug,
    colorPlanGroupSlug,
    brokerageSubgroup,
  };
}

export function buildDisplayValuationBlock(
  ts: ValuationTimeseriesResponse,
  ctx: GroupPageChartContext,
  grouped: boolean
) {
  if (ctx.liabilitiesGrouped) return ts.liab_grouped_block ?? ts.accounts_in_group ?? null;
  const g = ts.nav_grouped_blocks?.[grouped ? "grouped" : "ungrouped"];
  return g ?? ts.accounts_in_group ?? null;
}

export function buildDisplayPieSlices(
  ts: ValuationTimeseriesResponse,
  ctx: GroupPageChartContext,
  grouped: boolean
): GroupAllocationPieSlice[] {
  if (ctx.liabilitiesGrouped) return ts.liab_grouped_pie ?? ts.group_allocation_pie ?? [];
  const g = ts.nav_grouped_pie?.[grouped ? "grouped" : "ungrouped"];
  return g ?? ts.group_allocation_pie ?? [];
}

export function buildDisplayGroupPerf(
  groupPerf: GroupMonthlyPerformanceResponse | null,
  ctx: GroupPageChartContext,
  grouped: boolean
): GroupMonthlyPerformanceResponse | null {
  if (!groupPerf) return null;
  const g = ctx.liabilitiesGrouped
    ? groupPerf.liab_grouped_bars
    : groupPerf.nav_grouped_bars?.[grouped ? "grouped" : "ungrouped"];
  return g ? { ...groupPerf, bar_accounts: g.bar_accounts, points: g.points } : groupPerf;
}
