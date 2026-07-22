import { monthKeyFromYmd } from "./calendarMonth.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import type { TsUnit } from "./valuationTimeseries.js";

/**
 * Chained, flow-adjusted period returns (Rentabilidad). Pure / db-free.
 *
 * Each period geometrically links the monthly flow-adjusted returns (`pct_month`,
 * a fraction) that the monthly-performance builders already produce — aportes/retiros
 * are already netted out of `pct_month`, so this is an approximate time-weighted return.
 * Percentages here stay in the same FRACTION convention as `pct_month` (0.06 = 6%);
 * the client multiplies by 100 at the `formatPct` call site.
 *
 * Fail-fast: never fabricates a 0% for a window with no real return data — an
 * insufficient-history window (or an all-null-pct window) yields `pct: null`.
 */

export type PeriodReturnKey = "d1" | "w1" | "mtd" | "ytd" | "y1" | "y3" | "y5" | "total";

export const PERIOD_RETURN_ORDER: readonly PeriodReturnKey[] = [
  "mtd",
  "ytd",
  "y1",
  "y3",
  "y5",
  "total",
] as const;

export type PeriodReturnCell = {
  period: PeriodReturnKey;
  /** Chained flow-adjusted return over the window (fraction). Null = insufficient history / no return data. */
  pct: number | null;
  /** Sum of `nominal_pl` over the same window rows, in the request unit. Null when no row contributed. */
  nominal_pl: number | null;
  /** `(1+pct)^(12/elapsed_months) − 1`; only for windows spanning more than 12 months (y3, y5, long total). */
  annualized_pct: number | null;
  /** Number of monthly rows actually chained inside the window. */
  months: number;
  /** Earliest month key (`YYYY-MM`) that contributed, or null for an empty/insufficient window. */
  window_start_month: string | null;
  /** Prior-anchor date (`YYYY-MM-DD`) for sub-monthly windows (d1/w1); null for monthly windows. */
  window_start_date?: string | null;
};

export type PeriodReturnsPayload = {
  unit: TsUnit;
  /** Newest contributing row's `as_of_date`. */
  as_of_date: string;
  /** A row exists for the current Chile calendar month (MTD reflects an in-progress month). */
  mtd_is_live: boolean;
  /** Series start month key (`YYYY-MM`). */
  first_month: string;
  /** Fixed order: d1, w1, mtd, ytd, y1, y3, y5, total. */
  periods: PeriodReturnCell[];
};

/** Structural input — satisfied by both AccountMonthlyPerformanceRow and ConsolidatedMonthlyPerfRow. */
export type PeriodReturnInputRow = {
  as_of_date: string;
  pct_month: number | null;
  nominal_pl: number | null;
};

/** `YYYY-MM` shifted by `delta` calendar months. */
function addMonths(monthKey: string, delta: number): string {
  const [ys, ms] = monthKey.split("-");
  const y = Number(ys);
  const m = Number(ms);
  if (!Number.isFinite(y) || !Number.isFinite(m)) {
    throw new Error(`addMonths: invalid month key ${JSON.stringify(monthKey)}`);
  }
  const total = y * 12 + (m - 1) + delta;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return `${ny}-${String(nm).padStart(2, "0")}`;
}

/** Inclusive calendar-month span between two month keys (a <= b). */
function monthSpanInclusive(a: string, b: string): number {
  const [ay, am] = a.split("-").map(Number);
  const [by, bm] = b.split("-").map(Number);
  return (by - ay) * 12 + (bm - am) + 1;
}

type WindowResult = {
  pct: number | null;
  nominal_pl: number | null;
  months: number;
  window_start_month: string | null;
};

const EMPTY_WINDOW: WindowResult = {
  pct: null,
  nominal_pl: null,
  months: 0,
  window_start_month: null,
};

/** Chain present rows whose month key is within [startMk, endMk] (inclusive). */
function chainWindow(
  monthsAsc: readonly string[],
  byMonth: ReadonlyMap<string, PeriodReturnInputRow>,
  startMk: string,
  endMk: string
): WindowResult {
  let prod = 1;
  let sawPct = false;
  let nominal = 0;
  let sawNominal = false;
  let months = 0;
  let windowStart: string | null = null;

  for (const mk of monthsAsc) {
    if (mk < startMk || mk > endMk) continue;
    const row = byMonth.get(mk)!;
    if (windowStart == null) windowStart = mk;
    months += 1;
    const p = row.pct_month;
    if (p != null && Number.isFinite(p)) {
      prod *= 1 + p;
      sawPct = true;
    }
    const n = row.nominal_pl;
    if (n != null && Number.isFinite(n)) {
      nominal += n;
      sawNominal = true;
    }
  }

  if (months === 0) return EMPTY_WINDOW;
  return {
    pct: sawPct ? prod - 1 : null,
    nominal_pl: sawNominal ? nominal : null,
    months,
    window_start_month: windowStart,
  };
}

/** Annualize a cumulative fraction over `elapsedMonths`; only meaningful for windows > 12 months. */
function annualize(pct: number | null, elapsedMonths: number): number | null {
  if (pct == null || elapsedMonths <= 12 || !Number.isFinite(pct) || pct <= -1) return null;
  return Math.pow(1 + pct, 12 / elapsedMonths) - 1;
}

/**
 * @param rows monthly perf rows (any sort order); one row per calendar month is required.
 * @param todayYmd Chile "today" (injectable for tests) — anchors all trailing windows to its month.
 * @returns payload, or null when there are no rows.
 */
export function computePeriodReturns(
  rows: readonly PeriodReturnInputRow[],
  unit: TsUnit,
  todayYmd: string = chileCalendarTodayYmd()
): PeriodReturnsPayload | null {
  if (rows.length === 0) return null;

  const byMonth = new Map<string, PeriodReturnInputRow>();
  const asOfByMonth = new Map<string, string>();
  for (const row of rows) {
    const mk = monthKeyFromYmd(row.as_of_date);
    if (byMonth.has(mk)) {
      throw new Error(`computePeriodReturns: duplicate month key ${mk} (one row per month expected)`);
    }
    byMonth.set(mk, row);
    asOfByMonth.set(mk, row.as_of_date);
  }

  const monthsAsc = [...byMonth.keys()].sort();
  const firstMonth = monthsAsc[0]!;
  const lastMonth = monthsAsc[monthsAsc.length - 1]!;
  const anchorMk = monthKeyFromYmd(todayYmd);
  const currentYear = todayYmd.slice(0, 4);

  const mtdLive = byMonth.has(anchorMk);

  const mtd: WindowResult = mtdLive
    ? chainWindow(monthsAsc, byMonth, anchorMk, anchorMk)
    : EMPTY_WINDOW;
  const ytd = chainWindow(monthsAsc, byMonth, `${currentYear}-01`, anchorMk);

  const trailing = (nMonths: number): WindowResult => {
    const startMk = addMonths(anchorMk, -(nMonths - 1));
    // Insufficient history: the window reaches before the series start — never a shorter chain.
    if (firstMonth > startMk) return EMPTY_WINDOW;
    return chainWindow(monthsAsc, byMonth, startMk, anchorMk);
  };
  const y1 = trailing(12);
  const y3 = trailing(36);
  const y5 = trailing(60);
  const total = chainWindow(monthsAsc, byMonth, firstMonth, anchorMk);

  const totalElapsed = anchorMk >= firstMonth ? monthSpanInclusive(firstMonth, anchorMk) : 0;
  const ytdElapsed = ytd.window_start_month
    ? monthSpanInclusive(ytd.window_start_month, anchorMk)
    : 0;

  const cell = (
    period: PeriodReturnKey,
    w: WindowResult,
    elapsedMonths: number
  ): PeriodReturnCell => ({
    period,
    pct: w.pct,
    nominal_pl: w.nominal_pl,
    annualized_pct: annualize(w.pct, elapsedMonths),
    months: w.months,
    window_start_month: w.window_start_month,
  });

  const periods: PeriodReturnCell[] = [
    cell("mtd", mtd, 1),
    cell("ytd", ytd, ytdElapsed),
    cell("y1", y1, 12),
    cell("y3", y3, 36),
    cell("y5", y5, 60),
    cell("total", total, totalElapsed),
  ];

  return {
    unit,
    as_of_date: asOfByMonth.get(lastMonth)!,
    mtd_is_live: mtdLive,
    first_month: firstMonth,
    periods,
  };
}
