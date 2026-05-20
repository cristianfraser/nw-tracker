import type { TimeseriesBlock } from "./types";

/**
 * Latest consolidated valuation for a class tab block: class total line when present,
 * else sum of positive account series (excludes `exclude_from_group_totals`).
 */
export function latestTotalFromValuationBlock(block: TimeseriesBlock | null | undefined): number {
  if (!block) return 0;
  const pts = block.points;
  if (!pts?.length) return 0;
  const last = pts[pts.length - 1]!;
  const hasTotal = (block.accounts ?? []).some((a) => a.dataKey === "__group_val_total");
  if (hasTotal) {
    const v = last.__group_val_total;
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  let sum = 0;
  for (const a of block.accounts ?? []) {
    if (a.account_id <= 0) continue;
    if (a.exclude_from_group_totals) continue;
    const v = last[a.dataKey];
    if (typeof v === "number" && Number.isFinite(v)) sum += v;
  }
  return sum;
}

/** Sum latest valuation for the given account `dataKey`s (usually `String(account_id)`). */
export function latestSumForDataKeys(
  block: TimeseriesBlock | null | undefined,
  dataKeys: string[]
): number {
  if (!block || dataKeys.length === 0) return 0;
  const pts = block.points;
  if (!pts?.length) return 0;
  const last = pts[pts.length - 1]!;
  let sum = 0;
  for (const dk of dataKeys) {
    const v = last[dk];
    if (typeof v === "number" && Number.isFinite(v)) sum += v;
  }
  return sum;
}
