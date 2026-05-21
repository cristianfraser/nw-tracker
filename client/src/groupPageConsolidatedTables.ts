import type { AccountMonthlyPerformanceRow } from "./types";

export type ConsolidatedMonthlyPerfRow = {
  as_of_date: string;
  closing_value: number;
  prior_closing: number | null;
  net_capital_flow: number;
  stock_units_inflow: number;
  nominal_pl: number | null;
  pct_month: number | null;
  ytd_nominal_pl: number | null;
  cumulative_nominal_pl: number | null;
};

const MONTH_ROW_EPS = 0.01;

function addNullable(a: number | null, b: number | null): number | null {
  if (a == null && b == null) return null;
  return (a ?? 0) + (b ?? 0);
}

function recomputeYtdAndCumulative(
  rowsAsc: ConsolidatedMonthlyPerfRow[]
): ConsolidatedMonthlyPerfRow[] {
  let ytdYear = 0;
  let ytdRun = 0;
  let cumPl = 0;
  return rowsAsc.map((row) => {
    const y = Number(row.as_of_date.slice(0, 4));
    if (!Number.isFinite(y)) return row;
    if (y !== ytdYear) {
      ytdYear = y;
      ytdRun = 0;
    }
    const nominal = row.nominal_pl ?? 0;
    ytdRun += nominal;
    cumPl += nominal;
    return { ...row, ytd_nominal_pl: ytdRun, cumulative_nominal_pl: cumPl };
  });
}

/**
 * Sum each account's monthly performance by calendar month (latest snapshot in the month per account).
 */
export function consolidateAccountMonthlyPerf(
  byAccount: readonly {
    monthly: readonly AccountMonthlyPerformanceRow[];
  }[]
): ConsolidatedMonthlyPerfRow[] {
  const latestByAccountMonth = new Map<string, AccountMonthlyPerformanceRow>();
  for (let ai = 0; ai < byAccount.length; ai++) {
    for (const row of byAccount[ai]!.monthly) {
      const mk = row.as_of_date.slice(0, 7);
      const key = `${ai}:${mk}`;
      const prev = latestByAccountMonth.get(key);
      if (!prev || row.as_of_date > prev.as_of_date) {
        latestByAccountMonth.set(key, row);
      }
    }
  }

  const monthBuckets = new Map<string, ConsolidatedMonthlyPerfRow>();
  for (const row of latestByAccountMonth.values()) {
    const mk = row.as_of_date.slice(0, 7);
    const bucket =
      monthBuckets.get(mk) ??
      ({
        as_of_date: row.as_of_date,
        closing_value: 0,
        prior_closing: null as number | null,
        net_capital_flow: 0,
        stock_units_inflow: 0,
        nominal_pl: null as number | null,
        pct_month: null,
        ytd_nominal_pl: null,
        cumulative_nominal_pl: null,
      } satisfies ConsolidatedMonthlyPerfRow);

    bucket.as_of_date =
      bucket.as_of_date >= row.as_of_date ? bucket.as_of_date : row.as_of_date;
    bucket.closing_value += row.closing_value;
    bucket.prior_closing = addNullable(bucket.prior_closing, row.prior_closing);
    bucket.net_capital_flow += row.net_capital_flow;
    bucket.stock_units_inflow += row.stock_units_inflow;
    bucket.nominal_pl = addNullable(bucket.nominal_pl, row.nominal_pl);
    monthBuckets.set(mk, bucket);
  }

  const asc = [...monthBuckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, bucket]) => {
      const prior = bucket.prior_closing;
      const net = bucket.net_capital_flow;
      const nominal = bucket.nominal_pl;
      const denom = (prior ?? 0) + net;
      const pct =
        nominal != null &&
        Number.isFinite(nominal) &&
        Math.abs(denom) > MONTH_ROW_EPS &&
        Number.isFinite(nominal / denom)
          ? nominal / denom
          : null;
      return { ...bucket, pct_month: pct };
    });

  return recomputeYtdAndCumulative(asc).reverse();
}
