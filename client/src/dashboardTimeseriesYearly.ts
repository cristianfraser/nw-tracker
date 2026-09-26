import type { TimeseriesBlock } from "./types";

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

  return { accounts, lines, points: newPoints, referenceMilestoneByDate: block.referenceMilestoneByDate };
}

function numField(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

export type RollupPerfPointsYearlyOpts = {
  /** Monthly delta keys to sum within each calendar year. */
  sumKeys: readonly string[];
  /** YTD area key → the year's own total (optional). */
  ytdKey?: string;
  /**
   * Accumulated area key (optional) → the lifetime running level the monthly rows carry, taken
   * from the year's LAST row — never re-summed from the rows, so a year whose months were cut at
   * a Rango start keeps the full-history figure the monthly and daily views show.
   */
  accumKey?: string;
  /** Combined Δ line / total (optional; summed when present on rows). */
  totalKey?: string;
};

/**
 * One point per calendar year from monthly P/L rows: the deltas and the total sum, YTD is the
 * year's total, the accumulated level is sampled at year-end. The P/L combos feed it through
 * `clipMonthsThenRollup`, so a Rango that starts mid-year gives a partial first year — its bars,
 * total and YTD cover only the months inside the range.
 */
export function rollupPerfPointsYearly(
  points: readonly Record<string, string | number | null>[],
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
      const yearEnd = rows.reduce((a, r) =>
        String(r.as_of_date ?? "") >= String(a.as_of_date ?? "") ? r : a
      );
      const level = yearEnd[opts.accumKey];
      if (typeof level !== "number" || !Number.isFinite(level)) {
        const day = String(yearEnd.as_of_date);
        throw new Error(`rollupPerfPointsYearly: ${opts.accumKey} missing on the ${day} row`);
      }
      pt[opts.accumKey] = level;
    }

    out.push(pt);
  }

  return out;
}
