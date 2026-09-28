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

/**
 * The zero test of the return rules, one per unit: a value at or below the unit's smallest coin
 * (one peso, one US cent, 0,0001 UF) is no capital. It decides whether a period ENDS AT ZERO and
 * whether a capital base exists at all, on every grain — month rows, the dashboard, the daily
 * series, the 1D/1W cells. Until 2026-09-27 each caller passed its own eps (0.01 in either unit
 * for the monthly rows and the dashboard, 1e-9 for the daily series and 1D/1W), so an account
 * left holding a peso of dust after a withdrawal divided the day's fx move by that peso in USD
 * and read close to −100%, and a day that STARTED on dust read a return on a one-peso base.
 */
export const ZERO_CLOSE_EPS: Readonly<Record<TsUnit, number>> = {
  clp: 1,
  usd: 0.01,
  uf: 0.0001,
};

export function zeroCloseEps(unit: TsUnit): number {
  const eps = ZERO_CLOSE_EPS[unit];
  if (eps == null) throw new Error(`zeroCloseEps: unknown unit ${JSON.stringify(unit)}`);
  return eps;
}

/**
 * Flow-adjusted return over any period — a month row, a day of the daily series, the 1D/1W
 * cells, the dashboard's day/month/year/total, an equity position's return on deposited:
 * nominal P/L over the capital at work. The default frame charges flows at the period START
 * (`denom = prior + netFlow`). Zero is the unit's coin ({@link ZERO_CLOSE_EPS}).
 *
 * A period that ENDS AT ZERO (`|close| ≤ coin`: a position sold off, a deposit matured, an
 * account emptied, dust left behind) was emptied by a withdrawal at its end, so it charges
 * that withdrawal at the period END and divides by the prior close: in the start frame
 * `prior + netFlow` is then exactly `−nominal`, so a loss read −100% however small and a gain
 * had no positive base. With nothing at work before it (no prior close, or dust: bought and
 * sold inside the period) there is no base → null. A period that ends at zero on a net DEPOSIT
 * keeps the start frame: that money was at work too and all of it was lost, exactly −100% (the
 * prior close alone would read a loss beyond that).
 *
 * A period that does not end at zero but whose net withdrawal exceeds the prior close (a
 * partial liquidation that takes the period's gains too) also divides by the prior close,
 * the start denominator being ≤ 0. Null when no positive capital base exists in either
 * frame — among them a first period (no prior close) whose flows are net withdrawals — and
 * when the close is unknown (the frame cannot be chosen).
 */
export function flowAdjustedPct(
  nominal: number | null,
  prior: number | null,
  netFlow: number,
  close: number | null,
  unit: TsUnit
): number | null {
  if (nominal == null || !Number.isFinite(nominal)) return null;
  if (close == null || !Number.isFinite(close)) return null;
  const eps = zeroCloseEps(unit);
  const priorBase = prior != null && Number.isFinite(prior) ? prior : 0;
  const endsAtZero = Math.abs(close) <= eps;
  if (endsAtZero && !(priorBase > eps)) return null;
  const startFrameDenom = priorBase + netFlow;
  const denom =
    endsAtZero && netFlow <= 0
      ? priorBase
      : startFrameDenom > eps
        ? startFrameDenom
        : priorBase > eps
          ? priorBase
          : null;
  if (denom == null) return null;
  const pct = nominal / denom;
  return Number.isFinite(pct) ? pct : null;
}

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
    first_month: firstMonth,
    periods,
  };
}
