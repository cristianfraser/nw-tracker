/**
 * The two derived shapes every monthly performance table shares, built once on the server:
 * the running P/L totals (YTD, resetting each January, and since the first month) and the
 * yearly rollup the «Detalle por año» tables show. Per-account rows, group consolidations and
 * the net-worth / inversiones sums all go through these, so no table re-derives them.
 */

/** The fields both running totals and the yearly rollup read and write. */
export type MonthlyPerfRowShape = {
  as_of_date: string;
  net_capital_flow: number;
  stock_units_inflow: number;
  nominal_pl: number | null;
  pct_month: number | null;
  ytd_nominal_pl: number | null;
  cumulative_nominal_pl: number | null;
  end_charged_flow?: number;
};

/**
 * `ytd_nominal_pl` (since January of the row's year) and `cumulative_nominal_pl` (since the
 * first row) over rows in ascending date order. A month without P/L adds nothing to either.
 */
export function withRunningPlTotals<T extends MonthlyPerfRowShape>(rowsAsc: readonly T[]): T[] {
  let ytdYear = 0;
  let ytdRun = 0;
  let cumPl = 0;
  return rowsAsc.map((row) => {
    const y = Number(row.as_of_date.slice(0, 4));
    if (!Number.isFinite(y)) {
      throw new Error(`withRunningPlTotals: row dated ${row.as_of_date} has no year`);
    }
    if (y !== ytdYear) {
      ytdYear = y;
      ytdRun = 0;
    }
    const nominal = row.nominal_pl != null && Number.isFinite(row.nominal_pl) ? row.nominal_pl : 0;
    ytdRun += nominal;
    cumPl += nominal;
    return { ...row, ytd_nominal_pl: ytdRun, cumulative_nominal_pl: cumPl };
  });
}

function sumOrNull(values: readonly (number | null)[]): number | null {
  let sum: number | null = null;
  for (const v of values) {
    if (v != null && Number.isFinite(v)) sum = (sum ?? 0) + v;
  }
  return sum;
}

/**
 * One row per calendar year (dated `YYYY-12-31`), newest first: flows and P/L summed over the
 * year's months, the % compounds the months' %, the closing fields (closing value, cumulative
 * P/L, the mortgage's UF columns — everything not listed here) are the year's latest month and
 * YTD is null (the yearly tables have no YTD column). A year whose months all lack a P/L reads
 * null P/L, and one whose months all lack a % reads null %: an absent figure is never 0.
 */
export function rollupMonthlyPerfYearly<T extends MonthlyPerfRowShape>(rows: readonly T[]): T[] {
  const byYear = new Map<string, T[]>();
  for (const row of rows) {
    const year = row.as_of_date.slice(0, 4);
    const arr = byYear.get(year) ?? [];
    arr.push(row);
    byYear.set(year, arr);
  }
  const out: T[] = [];
  for (const year of [...byYear.keys()].sort((a, b) => b.localeCompare(a))) {
    const monthsAsc = [...byYear.get(year)!].sort((a, b) => a.as_of_date.localeCompare(b.as_of_date));
    const latest = monthsAsc[monthsAsc.length - 1]!;
    const pcts = monthsAsc
      .map((r) => r.pct_month)
      .filter((p): p is number => p != null && Number.isFinite(p));
    const pctYear = pcts.length ? pcts.reduce((prod, p) => prod * (1 + p), 1) - 1 : null;
    out.push({
      ...latest,
      as_of_date: `${year}-12-31`,
      net_capital_flow: monthsAsc.reduce((s, r) => s + r.net_capital_flow, 0),
      stock_units_inflow: monthsAsc.reduce((s, r) => s + r.stock_units_inflow, 0),
      nominal_pl: sumOrNull(monthsAsc.map((r) => r.nominal_pl)),
      pct_month: pctYear,
      ytd_nominal_pl: null,
      cumulative_nominal_pl: latest.cumulative_nominal_pl,
      ...(latest.end_charged_flow !== undefined
        ? { end_charged_flow: monthsAsc.reduce((s, r) => s + (r.end_charged_flow ?? 0), 0) }
        : {}),
    });
  }
  return out;
}
