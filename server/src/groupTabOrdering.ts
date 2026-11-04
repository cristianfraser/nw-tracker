import { accountMarkClpAtYmd } from "./accountMarkClpAtYmd.js";
import { chileCalendarAddDays, chileCalendarTodayYmd } from "./chileDate.js";
import {
  buildLiabilitiesChartBucketPlan,
  buildNavChartBucketPlan,
  isLiabilitiesChartNavNode,
} from "./groupChartBuckets.js";
import { getNavChartGroupNodeBySlug } from "./navTree.js";

type OrderableRow = { account_id: number; name: string };

/**
 * Bucket-major display ordering for group-tab account rows: nav-plan bucket position first (the
 * same buckets the "Agrupado" lines use, so ungrouped chart lines and % bands cluster by bucket
 * in bucket order), then yesterday's close (CLP mark) descending within the bucket, then name —
 * yesterday's so the order reads no live price and holds for the day (2026-11-04; see
 * `sortNavNodesByMarkDesc`). This is the single ordering authority for group-page chart lines, proportional bands,
 * P/L bars, accounts tables, and XLSX export rows — it replaces the legacy
 * `asset_groups.sort_order` ordering. The sidebar keeps its own seeded alphabetical order.
 */
export function orderGroupTabRowsBucketMajor<T extends OrderableRow>(
  rows: T[],
  planSlug: string
): T[] {
  if (rows.length <= 1) return rows;
  const node = getNavChartGroupNodeBySlug(planSlug);
  if (!node) return rows;
  const plan = isLiabilitiesChartNavNode(node)
    ? buildLiabilitiesChartBucketPlan(node)
    : buildNavChartBucketPlan(node, true);
  if (plan.orderedKeys.length === 0) return rows;

  const bucketIndex = new Map(plan.orderedKeys.map((key, i) => [key, i]));
  const yesterday = chileCalendarAddDays(chileCalendarTodayYmd(), -1);
  const sortKey = new Map<number, { bucket: number; value: number }>();
  for (const r of rows) {
    if (sortKey.has(r.account_id)) continue;
    const key = plan.idToBucket(r.account_id);
    const bucket = key != null ? bucketIndex.get(key)! : Number.MAX_SAFE_INTEGER;
    const mark = accountMarkClpAtYmd(r.account_id, yesterday);
    const value =
      mark != null && Number.isFinite(mark.value_clp) ? mark.value_clp : Number.NEGATIVE_INFINITY;
    sortKey.set(r.account_id, { bucket, value });
  }

  return [...rows].sort((a, b) => {
    const ka = sortKey.get(a.account_id)!;
    const kb = sortKey.get(b.account_id)!;
    if (ka.bucket !== kb.bucket) return ka.bucket - kb.bucket;
    if (ka.value !== kb.value) return kb.value - ka.value;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
}
