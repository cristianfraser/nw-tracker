import { buildNavChartBucketPlan, type NavChartBucketMeta } from "./navChartBuckets";
import {
  aggregatePerformanceByBucket,
  aggregatePieByBucket,
  aggregateValuationByBucket,
  type GroupChartBucketMeta,
} from "./groupedTimeseriesAggregation";
import type {
  AccountListRow,
  GroupMonthlyPerformanceResponse,
  NavTreeNodeDto,
  TimeseriesBlock,
} from "./types";

function toGroupMeta(meta: Record<string, NavChartBucketMeta>): Record<string, GroupChartBucketMeta> {
  const out: Record<string, GroupChartBucketMeta> = {};
  for (const [k, m] of Object.entries(meta)) {
    out[k] = {
      key: m.key,
      accountId: m.accountId,
      dataKey: m.dataKey,
      depKey: m.depKey,
      barDataKey: m.barDataKey,
      name: m.name,
      color_rgb: m.color_rgb,
    };
  }
  return out;
}

export function aggregateNavGroupedValuationBlock(
  block: TimeseriesBlock,
  listRows: AccountListRow[],
  navNode: NavTreeNodeDto,
  grouped: boolean
): TimeseriesBlock {
  const { orderedKeys, meta, idToBucket } = buildNavChartBucketPlan(navNode, grouped, listRows);
  return aggregateValuationByBucket(
    block,
    listRows,
    orderedKeys,
    toGroupMeta(meta),
    idToBucket
  );
}

export function aggregateNavGroupedPie(
  pie: { name: string; account_id: number; value: number }[],
  navNode: NavTreeNodeDto,
  grouped: boolean,
  listRows?: readonly Pick<AccountListRow, "id" | "bucket_slug" | "chart_inactive">[]
): { name: string; account_id: number; value: number }[] {
  const { orderedKeys, meta, idToBucket } = buildNavChartBucketPlan(navNode, grouped, listRows);
  return aggregatePieByBucket(pie, orderedKeys, toGroupMeta(meta), idToBucket);
}

export function aggregateNavGroupedPerformance(
  perf: GroupMonthlyPerformanceResponse,
  listRows: AccountListRow[],
  navNode: NavTreeNodeDto,
  grouped: boolean
): GroupMonthlyPerformanceResponse {
  const { orderedKeys, meta, idToBucket } = buildNavChartBucketPlan(navNode, grouped, listRows);
  return aggregatePerformanceByBucket(perf, listRows, orderedKeys, toGroupMeta(meta), (r) =>
    idToBucket(r.id)
  );
}
