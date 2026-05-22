import {
  aggregateBrokerageAllViewPerformance,
  aggregateBrokerageAllViewPie,
  aggregateBrokerageAllViewValuationBlock,
} from "./brokerageGroupedAggregation";
import {
  aggregateApvSubgroupGroupedPerformance,
  aggregateApvSubgroupGroupedPie,
  aggregateApvSubgroupGroupedValuationBlock,
  aggregateInversionesRootGroupedPerformance,
  aggregateInversionesRootGroupedPie,
  aggregateInversionesRootGroupedValuationBlock,
  aggregateInversionesRootUngroupedPerformance,
  aggregateInversionesRootUngroupedPie,
  aggregateInversionesRootUngroupedValuationBlock,
  aggregateRetiroGroupedPerformance,
  aggregateRetiroGroupedPie,
  aggregateRetiroGroupedValuationBlock,
} from "./inversionesGroupedAggregation";
import {
  aggregateLiabilitiesNavGroupedPerformance,
  aggregateLiabilitiesNavGroupedPie,
  aggregateLiabilitiesNavGroupedValuationBlock,
} from "./liabilitiesGroupedAggregation";
import { shouldAggregateLiabilitiesCharts } from "./liabilitiesChartBuckets";
import type {
  AccountListRow,
  GroupMonthlyPerformanceResponse,
  NavTreeNodeDto,
  ValuationTimeseriesResponse,
} from "./types";

export type GroupPageChartContext = {
  showGroupedToggle: boolean;
  rootInvTodas: boolean;
  retiroTodas: boolean;
  brokerageTodas: boolean;
  apvTodas: boolean;
  liabilitiesGrouped: boolean;
  chartColorSlug: string;
  pieAllocationSlug: string;
  colorPlanGroupSlug: "inversiones" | "brokerage" | "retirement";
  brokerageSubgroup?: "acciones" | "mutual_funds" | "crypto";
};

export function resolveGroupPageChartContext(navNode: NavTreeNodeDto): GroupPageChartContext {
  const slug = navNode.slug;
  const sub = navNode.api_subgroup ?? undefined;
  const apiGroup = navNode.api_group ?? "";

  const rootInvTodas = slug === "inversiones" && !sub;
  const retiroTodas = slug === "retirement" && !sub;
  const brokerageTodas = slug === "brokerage" && !sub;
  const apvTodas = slug === "retirement_apv" && sub === "apv";
  const liabilitiesGrouped = shouldAggregateLiabilitiesCharts(navNode);
  const showGroupedToggle = rootInvTodas || retiroTodas || brokerageTodas || apvTodas;

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
    rootInvTodas,
    retiroTodas,
    brokerageTodas,
    apvTodas,
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
  if (ctx.brokerageTodas && grouped) {
    return aggregateBrokerageAllViewValuationBlock(block, accounts);
  }
  if (ctx.rootInvTodas && grouped) {
    return aggregateInversionesRootGroupedValuationBlock(block, accounts);
  }
  if (ctx.rootInvTodas && !grouped) {
    return aggregateInversionesRootUngroupedValuationBlock(block, accounts);
  }
  if (ctx.retiroTodas && grouped) {
    return aggregateRetiroGroupedValuationBlock(block, accounts);
  }
  if (ctx.apvTodas && grouped) {
    return aggregateApvSubgroupGroupedValuationBlock(block, accounts);
  }
  return block;
}

export function buildDisplayPieSlices(
  ts: ValuationTimeseriesResponse,
  accounts: AccountListRow[],
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
    return aggregateLiabilitiesNavGroupedPie(base, navNode);
  }
  if (ctx.brokerageTodas && grouped) {
    return aggregateBrokerageAllViewPie(ts.group_allocation_pie ?? [], accounts);
  }
  if (ctx.rootInvTodas && grouped) {
    return aggregateInversionesRootGroupedPie(ts.group_allocation_pie ?? [], accounts);
  }
  if (ctx.rootInvTodas && !grouped) {
    return aggregateInversionesRootUngroupedPie(ts.group_allocation_pie ?? [], accounts);
  }
  if (ctx.retiroTodas && grouped) {
    return aggregateRetiroGroupedPie(ts.group_allocation_pie ?? [], accounts);
  }
  if (ctx.apvTodas && grouped) {
    return aggregateApvSubgroupGroupedPie(ts.group_allocation_pie ?? [], accounts);
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
  if (ctx.brokerageTodas && grouped) {
    return aggregateBrokerageAllViewPerformance(groupPerf, accounts);
  }
  if (ctx.rootInvTodas && grouped) {
    return aggregateInversionesRootGroupedPerformance(groupPerf, accounts);
  }
  if (ctx.rootInvTodas && !grouped) {
    return aggregateInversionesRootUngroupedPerformance(groupPerf, accounts);
  }
  if (ctx.retiroTodas && grouped) {
    return aggregateRetiroGroupedPerformance(groupPerf, accounts);
  }
  if (ctx.apvTodas && grouped) {
    return aggregateApvSubgroupGroupedPerformance(groupPerf, accounts);
  }
  return groupPerf;
}
