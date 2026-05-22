import {
  buildLiabilitiesBucketPlan,
  type LiabilitiesChartBucketMeta,
} from "./liabilitiesChartBuckets";
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

function toGroupMeta(
  meta: Record<string, LiabilitiesChartBucketMeta>
): Record<string, GroupChartBucketMeta> {
  const out: Record<string, GroupChartBucketMeta> = {};
  for (const [k, m] of Object.entries(meta)) {
    out[k] = {
      key: m.key,
      accountId: m.accountId,
      dataKey: m.dataKey,
      depKey: m.depKey,
      barDataKey: m.barDataKey,
      name: m.name,
    };
  }
  return out;
}

export function aggregateLiabilitiesNavGroupedValuationBlock(
  block: TimeseriesBlock,
  listRows: AccountListRow[],
  navNode: NavTreeNodeDto
): TimeseriesBlock {
  const { orderedKeys, meta, idToBucket } = buildLiabilitiesBucketPlan(navNode);
  return aggregateValuationByBucket(
    block,
    listRows,
    orderedKeys,
    toGroupMeta(meta),
    idToBucket
  );
}

export function aggregateLiabilitiesNavGroupedPie(
  pie: { name: string; account_id: number; value: number }[],
  navNode: NavTreeNodeDto
): { name: string; account_id: number; value: number }[] {
  const { orderedKeys, meta, idToBucket } = buildLiabilitiesBucketPlan(navNode);
  return aggregatePieByBucket(pie, orderedKeys, toGroupMeta(meta), idToBucket);
}

export function aggregateLiabilitiesNavGroupedPerformance(
  perf: GroupMonthlyPerformanceResponse,
  listRows: AccountListRow[],
  navNode: NavTreeNodeDto
): GroupMonthlyPerformanceResponse {
  const { orderedKeys, meta, idToBucket } = buildLiabilitiesBucketPlan(navNode);
  return aggregatePerformanceByBucket(perf, listRows, orderedKeys, toGroupMeta(meta), (r) =>
    idToBucket(r.id)
  );
}
