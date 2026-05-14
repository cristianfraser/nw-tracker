import type { TimeseriesBlock } from "./types";

export type DashboardChartGranularity = "monthly" | "yearly";

function calendarYearFromAsOf(d: string): number | null {
  const y = Number(String(d).slice(0, 4));
  return Number.isFinite(y) ? y : null;
}

/**
 * One point per calendar year: values from the **last** month-end row in that year (year-end positions).
 * Use for valuation / balance lines — summing month-end levels would double-count.
 */
export function rollupTimeseriesBlockYearEnd(block: TimeseriesBlock): TimeseriesBlock {
  const { points, accounts, lines } = block;
  if (!points.length) return block;

  const byYear = new Map<number, Record<string, string | number | null>[]>();
  for (const row of points) {
    const y = calendarYearFromAsOf(String(row.as_of_date ?? ""));
    if (y == null) continue;
    if (!byYear.has(y)) byYear.set(y, []);
    byYear.get(y)!.push(row);
  }

  const years = [...byYear.keys()].sort((a, b) => a - b);
  const newPoints = years.map((y) => {
    const rows = byYear.get(y)!.sort((a, b) => String(a.as_of_date).localeCompare(String(b.as_of_date)));
    const last = { ...rows[rows.length - 1]! };
    last.as_of_date = `${y}-12-31`;
    return last;
  });

  return { accounts, lines, points: newPoints };
}

/**
 * One point per calendar year: **sums** monthly retirement/brokerage class deltas;
 * `ytd_combined` = that year’s combined total (same as `delta_combined` for each year row);
 * `accumulated_earnings` = running sum of annual combined totals from the first year.
 */
export function rollupRetirementBrokeragePerfYearly(
  points: Record<string, string | number | null>[]
): Record<string, string | number | null>[] {
  if (!points.length) return [];

  const byY = new Map<number, { ret: number; brk: number }>();
  for (const row of points) {
    const y = calendarYearFromAsOf(String(row.as_of_date ?? ""));
    if (y == null) continue;
    const ret =
      typeof row.delta_retirement === "number" && Number.isFinite(row.delta_retirement)
        ? row.delta_retirement
        : 0;
    const brk =
      typeof row.delta_brokerage === "number" && Number.isFinite(row.delta_brokerage) ? row.delta_brokerage : 0;
    const cur = byY.get(y) ?? { ret: 0, brk: 0 };
    cur.ret += ret;
    cur.brk += brk;
    byY.set(y, cur);
  }

  const years = [...byY.keys()].sort((a, b) => a - b);
  let cumLife = 0;
  const out: Record<string, string | number | null>[] = [];
  for (const y of years) {
    const { ret, brk } = byY.get(y)!;
    const combined = ret + brk;
    cumLife += combined;
    out.push({
      as_of_date: `${y}-12-31`,
      delta_retirement: ret,
      delta_brokerage: brk,
      delta_combined: combined,
      ytd_combined: combined,
      accumulated_earnings: cumLife,
    });
  }
  return out;
}
