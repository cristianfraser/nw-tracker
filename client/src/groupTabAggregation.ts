import i18n from "./i18n";
import type { TimeseriesAccountLine, TimeseriesBlock } from "./types";

export const GROUP_TAB_VAL_TOTAL = "__group_val_total";
export const GROUP_TAB_DEP_TOTAL = "__group_dep_total";

export function addNullableNumbers(a: unknown, b: unknown): number | null {
  const na = typeof a === "number" && Number.isFinite(a) ? a : null;
  const nb = typeof b === "number" && Number.isFinite(b) ? b : null;
  if (na == null && nb == null) return null;
  return (na ?? 0) + (nb ?? 0);
}

export function accountCountsTowardGroupTotalsClient(a: TimeseriesAccountLine): boolean {
  return a.account_id <= 0 || !a.exclude_from_group_totals;
}

/** Same idea as server `appendGroupTabTotals`: prepend total valuation + optional total deposits. */
export function appendGroupTabTotalsClient(block: TimeseriesBlock): TimeseriesBlock {
  const src = block.accounts ?? [];
  if (src.length === 0 || block.points.length === 0) return block;
  if (src.length === 1) return block;

  const anyChildDep = src.some((a) => Boolean(a.depositDataKey));

  const points = block.points.map((row) => {
    let vSum = 0;
    let vAny = false;
    let dSum = 0;
    let dAny = false;
    for (const a of src) {
      if (!accountCountsTowardGroupTotalsClient(a)) continue;
      const v = row[a.dataKey];
      if (typeof v === "number" && Number.isFinite(v)) {
        vSum += v;
        vAny = true;
      }
      if (a.depositDataKey) {
        const d = row[a.depositDataKey];
        if (typeof d === "number" && Number.isFinite(d)) {
          dSum += d;
          dAny = true;
        }
      }
    }
    const out: Record<string, string | number | null> = {
      ...row,
      [GROUP_TAB_VAL_TOTAL]: vAny ? vSum : null,
    };
    if (anyChildDep) {
      out[GROUP_TAB_DEP_TOTAL] = dAny ? dSum : null;
    }
    return out;
  });

  const totalLine: TimeseriesAccountLine = anyChildDep
    ? {
        account_id: -1,
        name: "Total",
        dataKey: GROUP_TAB_VAL_TOTAL,
        valueSeriesType: "reference",
        depositDataKey: GROUP_TAB_DEP_TOTAL,
        deposit_series_name: i18n.t("charts.groupAccumulatedDeposits"),
      }
    : {
        account_id: -1,
        name: "Total",
        dataKey: GROUP_TAB_VAL_TOTAL,
        valueSeriesType: "reference",
      };

  return {
    accounts: [totalLine, ...src],
    points,
    ...(block.lines?.length ? { lines: block.lines } : {}),
  };
}
