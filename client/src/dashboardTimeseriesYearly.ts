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

function numField(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

export type RollupPerfPointsYearlyOpts = {
  /** Monthly delta keys to sum within each calendar year. */
  sumKeys: string[];
  /** YTD area key → annual total for that year (optional). */
  ytdKey?: string;
  /** Cumulative area key → running sum of annual totals (optional). */
  accumKey?: string;
  /** Combined Δ line / total (optional; summed when present on rows). */
  totalKey?: string;
};

/**
 * One point per calendar year: sums monthly performance deltas; optional YTD = annual total,
 * optional cumulative = running sum of annual totals (same rules as dashboard retirement/brokerage rollup).
 */
export function rollupPerfPointsYearly(
  points: Record<string, string | number | null>[],
  opts: RollupPerfPointsYearlyOpts
): Record<string, string | number | null>[] {
  if (!points.length) return [];

  const totalKey = opts.totalKey ?? "delta_total";
  const byYear = new Map<number, Record<string, string | number | null>[]>();
  for (const row of points) {
    const y = calendarYearFromAsOf(String(row.as_of_date ?? ""));
    if (y == null) continue;
    if (!byYear.has(y)) byYear.set(y, []);
    byYear.get(y)!.push(row);
  }

  let cumLife = 0;
  const years = [...byYear.keys()].sort((a, b) => a - b);
  const out: Record<string, string | number | null>[] = [];

  for (const y of years) {
    const rows = byYear.get(y)!;
    const pt: Record<string, string | number | null> = { as_of_date: `${y}-12-31` };

    for (const k of opts.sumKeys) {
      let s = 0;
      for (const row of rows) s += numField(row[k]);
      pt[k] = s;
    }

    let deltaTotal = 0;
    if (rows.some((r) => totalKey in r)) {
      for (const row of rows) deltaTotal += numField(row[totalKey]);
      pt[totalKey] = deltaTotal;
    } else {
      for (const k of opts.sumKeys) deltaTotal += numField(pt[k]);
      pt[totalKey] = deltaTotal;
    }

    if (opts.ytdKey) pt[opts.ytdKey] = deltaTotal;
    if (opts.accumKey) {
      cumLife += deltaTotal;
      pt[opts.accumKey] = cumLife;
    }

    out.push(pt);
  }

  return out;
}
