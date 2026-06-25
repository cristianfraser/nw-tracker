import { shouldAggregateLiabilitiesCharts } from "./liabilitiesChartBuckets";
import {
  aggregateLiabilitiesNavGroupedPerformance,
  aggregateLiabilitiesNavGroupedPie,
  aggregateLiabilitiesNavGroupedValuationBlock,
} from "./liabilitiesGroupedAggregation";
import { shouldAggregateNavCharts, shouldShowNavGroupedChartToggle } from "./navChartBuckets";
import {
  aggregateNavGroupedPerformance,
  aggregateNavGroupedPie,
  aggregateNavGroupedValuationBlock,
} from "./navGroupedChartAggregation";
import type {
  AccountListRow,
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

export function resolveGroupPageChartContext(
  navNode: NavTreeNodeDto,
  listRows?: readonly AccountListRow[]
): GroupPageChartContext {
  const sub = navNode.api_subgroup ?? undefined;
  const apiGroup = navNode.api_group ?? "";

  const liabilitiesGrouped = shouldAggregateLiabilitiesCharts(navNode, listRows);
  const showGroupedToggle = liabilitiesGrouped || shouldShowNavGroupedChartToggle(navNode);

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
  accounts: AccountListRow[],
  ctx: GroupPageChartContext,
  grouped: boolean,
  navNode?: NavTreeNodeDto | null
) {
  const block = ts.accounts_in_group;
  if (!block) return null;
  if (ctx.liabilitiesGrouped && navNode) {
    return aggregateLiabilitiesNavGroupedValuationBlock(block, accounts, navNode);
  }
  if (navNode && shouldAggregateNavCharts(navNode, grouped)) {
    return aggregateNavGroupedValuationBlock(block, accounts, navNode, grouped);
  }
  return block;
}

export function buildDisplayPieSlices(
  ts: ValuationTimeseriesResponse,
  _accounts: AccountListRow[],
  ctx: GroupPageChartContext,
  grouped: boolean,
  navNode?: NavTreeNodeDto | null
) {
  const base = (ts.group_allocation_pie ?? []).map((p) => ({
    name: p.name,
    value: p.value,
    account_id: p.account_id,
  }));
  if (ctx.liabilitiesGrouped && navNode) {
    return aggregateLiabilitiesNavGroupedPie(base, navNode, _accounts);
  }
  if (navNode && shouldAggregateNavCharts(navNode, grouped)) {
    return aggregateNavGroupedPie(base, navNode, grouped, _accounts);
  }
  return base;
}

export function buildDisplayGroupPerf(
  groupPerf: GroupMonthlyPerformanceResponse | null,
  accounts: AccountListRow[],
  ctx: GroupPageChartContext,
  grouped: boolean,
  navNode?: NavTreeNodeDto | null
) {
  if (!groupPerf) return null;
  if (ctx.liabilitiesGrouped && navNode) {
    return aggregateLiabilitiesNavGroupedPerformance(groupPerf, accounts, navNode);
  }
  if (navNode && shouldAggregateNavCharts(navNode, grouped)) {
    return aggregateNavGroupedPerformance(groupPerf, accounts, navNode, grouped);
  }
  return groupPerf;
}
