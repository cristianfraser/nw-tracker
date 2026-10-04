import { db } from "./db.js";
import { resolveEquityQuote } from "./equityQuote.js";
import { resolveGroupDailySeries } from "./groupDailySeries.js";
import type { TsUnit } from "./valuationTimeseries.js";

/**
 * Benchmarks for the Rentabilidad comparison (`benchmarks`, migration 207) and their daily
 * total-return level in the benchmark's own currency. The comparison only ever reads ratios
 * of levels, so a level's scale is arbitrary.
 *
 * Kinds:
 * - `equity_with_dividends`: the ticker's close × the shares one share became by reinvesting
 *   each dividend at its ex-date close, net of the withholding a holder in Chile suffers.
 * - `fund_unit`: a `fund_unit_daily` series (a fund's valor cuota already includes everything).
 * - `index_plus_rate`: an index (UF) compounded at a fixed yearly rate, day by day.
 * - `portfolio_group`: one of the user's own groups — its time-weighted return, each day's
 *   flow-adjusted `pct` from the group's daily series chained, in the display unit (so its
 *   level is already in that unit). It starts the day before the group's first return; a
 *   later day without one (the group held nothing) is flat.
 *
 * A date before the series' first observation has no level (null). A date inside the series
 * reads the observation on or before it; one older than {@link MAX_CARRY_DAYS} throws — a
 * stale series, not a weekend.
 */

export type BenchmarkKind = "equity_with_dividends" | "fund_unit" | "index_plus_rate" | "portfolio_group";

export type BenchmarkRow = {
  slug: string;
  kind: BenchmarkKind;
  /** Null for `portfolio_group` rows: they are named by their group. */
  label_i18n_key: string | null;
  ticker: string | null;
  withholding_pct: number | null;
  series_key: string | null;
  index_key: "uf" | null;
  rate_pct: number | null;
  portfolio_group_slug: string | null;
  sort_order: number;
};

export type BenchmarkLevelSeries = {
  /** The level's unit: a market series' quote currency, or the display unit (`portfolio_group`). */
  currency: TsUnit;
  /** First date with a level; null when the series has no data at all. */
  first_ymd: string | null;
  /** Level on `ymd` (null before `first_ymd`). `today` reads a live price where one applies. */
  levelAt: (ymd: string) => number | null;
};

export const MAX_CARRY_DAYS = 10;

export function listBenchmarks(): BenchmarkRow[] {
  return db
    .prepare(
      `SELECT slug, kind, label_i18n_key, ticker, withholding_pct, series_key, index_key, rate_pct,
              portfolio_group_slug, sort_order
       FROM benchmarks ORDER BY sort_order, slug`
    )
    .all() as BenchmarkRow[];
}

export function getBenchmark(slug: string): BenchmarkRow | null {
  return listBenchmarks().find((b) => b.slug === slug) ?? null;
}

/** Equity tickers whose closes and dividends a benchmark needs (kept current by the EOD sync). */
export function listBenchmarkEquityTickers(): string[] {
  return listBenchmarks()
    .filter((b) => b.kind === "equity_with_dividends" && b.ticker != null)
    .map((b) => b.ticker!);
}

function utcDays(ymd: string): number {
  const [y, m, d] = ymd.split("-").map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) {
    throw new Error(`benchmark: invalid date ${JSON.stringify(ymd)}`);
  }
  return Date.UTC(y!, m! - 1, d!) / 86_400_000;
}

/** Index of the last `dates[i] <= ymd`, or −1. */
function onOrBeforeIndex(dates: readonly string[], ymd: string): number {
  let lo = 0;
  let hi = dates.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (dates[mid]! <= ymd) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

function assertFresh(slug: string, observedYmd: string, ymd: string): void {
  if (utcDays(ymd) - utcDays(observedYmd) > MAX_CARRY_DAYS) {
    throw new Error(
      `benchmark ${slug}: latest observation on or before ${ymd} is ${observedYmd} (over ${MAX_CARRY_DAYS} days old) — sync the series`
    );
  }
}

/** Sorted observations → on-or-before lookup with the staleness check. */
function stepSeries(slug: string, dates: string[], values: number[]): (ymd: string) => number | null {
  return (ymd) => {
    const i = onOrBeforeIndex(dates, ymd);
    if (i < 0) return null;
    assertFresh(slug, dates[i]!, ymd);
    return values[i]!;
  };
}

/**
 * Total-return factor per close date: 1 before the first dividend, × (1 + net dividend ÷ the
 * ex-date close) from each ex-date on. Pure; exported for tests.
 */
export function totalReturnFactors(
  closeDates: readonly string[],
  closes: readonly number[],
  dividends: readonly { ex_date: string; amount: number }[],
  withholdingPct: number
): number[] {
  if (!(withholdingPct >= 0 && withholdingPct < 100)) {
    throw new Error(`benchmark: withholding ${withholdingPct}% out of range`);
  }
  const net = 1 - withholdingPct / 100;
  const byExDate = new Map<string, number>();
  for (const d of dividends) {
    if (closeDates.length === 0 || d.ex_date < closeDates[0]!) continue;
    byExDate.set(d.ex_date, (byExDate.get(d.ex_date) ?? 0) + d.amount);
  }
  const matched = new Set<string>();
  const factors: number[] = [];
  let factor = 1;
  for (let i = 0; i < closeDates.length; i++) {
    const amt = byExDate.get(closeDates[i]!);
    if (amt != null) {
      factor *= 1 + (amt * net) / closes[i]!;
      matched.add(closeDates[i]!);
    }
    factors.push(factor);
  }
  for (const exDate of byExDate.keys()) {
    if (!matched.has(exDate) && exDate <= closeDates[closeDates.length - 1]!) {
      throw new Error(`benchmark: dividend ex-date ${exDate} has no close`);
    }
  }
  return factors;
}

function equityLevels(b: BenchmarkRow, todayYmd: string, now: Date): BenchmarkLevelSeries {
  const ticker = b.ticker!;
  const rows = db
    .prepare(`SELECT trade_date, close, currency FROM equity_daily WHERE ticker = ? ORDER BY trade_date`)
    .all(ticker) as { trade_date: string; close: number; currency: string }[];
  const currency = rows[0]?.currency;
  for (const r of rows) {
    if (r.currency !== currency) throw new Error(`benchmark ${b.slug}: ${ticker} closes mix currencies`);
  }
  const divs = db
    .prepare(`SELECT ex_date, amount, currency FROM equity_dividends WHERE ticker = ? ORDER BY ex_date`)
    .all(ticker) as { ex_date: string; amount: number; currency: string }[];
  for (const d of divs) {
    if (d.currency !== currency) {
      throw new Error(`benchmark ${b.slug}: ${ticker} dividend ${d.ex_date} in ${d.currency}, closes in ${currency}`);
    }
  }
  if (rows.length === 0) return { currency: "usd", first_ymd: null, levelAt: () => null };
  // A dividend benchmark with no dividend on file would read as a price-only return.
  if (divs.length === 0) {
    throw new Error(
      `benchmark ${b.slug}: no ${ticker} dividends stored — run npm run backfill:equity-dividends -w nw-tracker-server`
    );
  }
  if (currency !== "usd" && currency !== "clp") throw new Error(`benchmark ${b.slug}: currency ${currency}`);

  const dates = rows.map((r) => r.trade_date);
  const closes = rows.map((r) => r.close);
  const factors = totalReturnFactors(dates, closes, divs, b.withholding_pct!);
  const levels = closes.map((c, i) => c * factors[i]!);
  const historical = stepSeries(b.slug, dates, levels);

  return {
    currency,
    first_ymd: dates[0]!,
    levelAt: (ymd) => {
      if (ymd !== todayYmd) return historical(ymd);
      const i = onOrBeforeIndex(dates, ymd);
      if (i < 0) return null;
      const q = resolveEquityQuote(ticker, ymd, { preferLive: true, now });
      if (q == null) return historical(ymd);
      if (q.currency !== currency) throw new Error(`benchmark ${b.slug}: live quote in ${q.currency}`);
      assertFresh(b.slug, q.trade_date, ymd);
      // A dividend whose ex-date is today already sits in the stored factors only once its
      // close is stored; the live price is ex-dividend, so add it here.
      const exToday = divs.filter((d) => d.ex_date === ymd && d.ex_date > dates[i]!);
      let factor = factors[i]!;
      for (const d of exToday) factor *= 1 + (d.amount * (1 - b.withholding_pct! / 100)) / q.price;
      return q.price * factor;
    },
  };
}

function fundLevels(b: BenchmarkRow): BenchmarkLevelSeries {
  const rows = db
    .prepare(`SELECT day, unit_value_clp FROM fund_unit_daily WHERE series_key = ? ORDER BY day`)
    .all(b.series_key!) as { day: string; unit_value_clp: number }[];
  if (rows.length === 0) return { currency: "clp", first_ymd: null, levelAt: () => null };
  return {
    currency: "clp",
    first_ymd: rows[0]!.day,
    levelAt: stepSeries(
      b.slug,
      rows.map((r) => r.day),
      rows.map((r) => r.unit_value_clp)
    ),
  };
}

function indexPlusRateLevels(b: BenchmarkRow): BenchmarkLevelSeries {
  if (b.index_key !== "uf") throw new Error(`benchmark ${b.slug}: unknown index ${b.index_key}`);
  const rows = db.prepare(`SELECT date, clp_per_uf FROM uf_daily ORDER BY date`).all() as {
    date: string;
    clp_per_uf: number;
  }[];
  if (rows.length === 0) return { currency: "clp", first_ymd: null, levelAt: () => null };
  const index = stepSeries(
    b.slug,
    rows.map((r) => r.date),
    rows.map((r) => r.clp_per_uf)
  );
  const yearly = 1 + b.rate_pct! / 100;
  const base = utcDays(rows[0]!.date);
  return {
    currency: "clp",
    first_ymd: rows[0]!.date,
    levelAt: (ymd) => {
      const v = index(ymd);
      if (v == null) return null;
      return v * Math.pow(yearly, (utcDays(ymd) - base) / 365);
    },
  };
}

/**
 * A time-weighted level from daily returns: it starts at 1 on the day before the first return
 * and multiplies in each later one; a day without a return (nothing held) is flat. Pure.
 */
export function chainDailyReturns(
  points: readonly { as_of_date: string; pct: number | null }[]
): { dates: string[]; levels: number[] } {
  const dates: string[] = [];
  const levels: number[] = [];
  let level = 1;
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    const has = p.pct != null && Number.isFinite(p.pct);
    if (dates.length === 0) {
      if (!has || i === 0) continue;
      dates.push(points[i - 1]!.as_of_date);
      levels.push(level);
    }
    if (has) level *= 1 + p.pct!;
    dates.push(p.as_of_date);
    levels.push(level);
  }
  return { dates, levels };
}

function portfolioGroupLevels(b: BenchmarkRow, unit: TsUnit): BenchmarkLevelSeries {
  const series = resolveGroupDailySeries(b.portfolio_group_slug!, unit, 0);
  const { dates, levels } = chainDailyReturns(series?.points ?? []);
  if (dates.length === 0) return { currency: unit, first_ymd: null, levelAt: () => null };
  return { currency: unit, first_ymd: dates[0]!, levelAt: stepSeries(b.slug, dates, levels) };
}

export function benchmarkLevelSeries(
  b: BenchmarkRow,
  todayYmd: string,
  now: Date,
  unit: TsUnit
): BenchmarkLevelSeries {
  switch (b.kind) {
    case "portfolio_group":
      return portfolioGroupLevels(b, unit);
    case "equity_with_dividends":
      return equityLevels(b, todayYmd, now);
    case "fund_unit":
      return fundLevels(b);
    case "index_plus_rate":
      return indexPlusRateLevels(b);
    default:
      throw new Error(`benchmark ${(b as BenchmarkRow).slug}: unknown kind ${(b as BenchmarkRow).kind}`);
  }
}
