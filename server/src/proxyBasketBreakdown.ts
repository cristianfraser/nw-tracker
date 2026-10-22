/**
 * Per-holding breakdown of a proxy basket (the ETF sleeve that stands in for Risky Norris) for
 * the value map: for every holding the fund STATES in its latest basket, the ETF's return over
 * the days the fund held it inside each card period, and its contribution to the fund's return.
 *
 * Inputs: the basket history in `watchlist_composite_positions` / `_position_holdings`
 * (`watchlistCompositeHistory.ts` — Fintual's own tickers, weights normalized to the ETF sleeve,
 * `etf_weight_sum` = the sleeve's share of fund assets), closes in `equity_daily` through
 * `equityCloseEod` (on-or-before, so a weekend day repeats Friday's close and returns 0), the live
 * or held quote for today (`resolveEquityQuote`, the same resolution the watchlist row uses), and
 * the dólar observado frame fx (`observadoFrameFxForDay`) for the CLP leg — the fx a Fintual
 * cuota actually embeds, see `fxObservadoFrame.ts`.
 *
 * Periods are the dashboard cards' windows (anchor, today]: day = since Chile yesterday, month =
 * since the prior month-end, year = since the prior Dec 31 (`priorPeriodEndYmd`), so a tile's
 * return lines up with the frame it sits in. For each Chile calendar day d in a window the
 * holding is HELD when the latest basket stated on or before d − 1 — the basket in force when
 * the day's move happened — gives it a weight above 0; a day before the bucket's first stated
 * basket cannot be classified and throws (the real history starts 2018-02).
 *
 * Approximations, by design:
 * - Weights STEP between positions dates: the in-force basket's weights hold unchanged until the
 *   next statement; no drift from the holdings' own price moves between statements.
 * - `contribution_pct` is the plain Σ over held days of w(d − 1) × r(d), with w = stated
 *   weight × that basket's `etf_weight_sum` — daily contributions are summed, not linked, so
 *   the holdings' contributions add up to the fund's arithmetic daily-return sum, not to its
 *   compounded return (the difference is second order over a year).
 * - `pct` chains only the held days: a holding that left and came back has the two windows
 *   multiplied together, the days out contribute a factor of 1.
 */
import { priorPeriodEndYmd } from "./accountPeriodMarks.js";
import { chileCalendarAddDays, chileWallClockAt } from "./chileDate.js";
import type { CardMetricsPeriod, NavCardPctDto } from "./dashboardNavCardMetrics.js";
import { db } from "./db.js";
import {
  equityCloseEod,
  equityQuoteCurrency,
  equitySessionYmdForTicker,
  resolveEquityQuote,
} from "./equityQuote.js";
import { FINTUAL_TICKER_PRICE_PROXY } from "./fintualRiskyNorrisComposition.js";
import { observadoFrameFxForDay } from "./fxObservadoFrame.js";
import type { ProxyBasketBreakdown, ProxyHoldingBreakdown } from "./proxyBasketBreakdownTypes.js";
import { loadCompositePositions, type CompositePositionsRow } from "./watchlistCompositeHistory.js";

export type { ProxyBasketBreakdown, ProxyHoldingBreakdown } from "./proxyBasketBreakdownTypes.js";

const PERIODS: readonly CardMetricsPeriod[] = ["day", "month", "year"];

/** An `etf_weight_sum` this far above 1 is a rendering residue, not a short non-ETF sleeve. */
const OTHER_WEIGHT_NEGATIVE_TOLERANCE = 1e-6;

const stmtListDates = db.prepare(
  `SELECT positions_date FROM watchlist_composite_positions WHERE bucket_slug = ? ORDER BY positions_date`
);

/** Every basket stated for the bucket, oldest first, each with its holdings. */
function loadPositionsHistory(bucketSlug: string): CompositePositionsRow[] {
  const dates = (stmtListDates.all(bucketSlug) as { positions_date: string }[]).map((r) => r.positions_date);
  return dates.map((date) => {
    const row = loadCompositePositions(bucketSlug, date);
    if (row == null) throw new Error(`proxy basket ${bucketSlug}: positions row ${date} vanished mid-read`);
    return row;
  });
}

function otherWeightFromSleeve(bucketSlug: string, row: CompositePositionsRow): number {
  if (row.etf_weight_sum == null || !Number.isFinite(row.etf_weight_sum)) {
    throw new Error(
      `proxy basket ${bucketSlug}: positions row ${row.positions_date} has no etf_weight_sum — cannot size the non-ETF sleeve`
    );
  }
  const other = 1 - row.etf_weight_sum;
  if (other < -OTHER_WEIGHT_NEGATIVE_TOLERANCE) {
    throw new Error(
      `proxy basket ${bucketSlug}: positions row ${row.positions_date} states an ETF sleeve above the whole fund (${row.etf_weight_sum})`
    );
  }
  return Math.max(0, other);
}

/**
 * The ETF's share of the WHOLE fund in a stated basket: stated sleeve weight × the sleeve's
 * share of assets; 0 when the basket does not hold it. A held ticker in a basket without an
 * `etf_weight_sum` cannot be weighted and throws.
 */
function fundWeightIn(bucketSlug: string, row: CompositePositionsRow, ticker: string): number {
  const stated = row.holdings.find((h) => h.ticker === ticker)?.weight ?? 0;
  if (stated <= 0) return 0;
  if (row.etf_weight_sum == null || !Number.isFinite(row.etf_weight_sum)) {
    throw new Error(
      `proxy basket ${bucketSlug}: positions row ${row.positions_date} holds ${ticker} but has no etf_weight_sum`
    );
  }
  return stated * row.etf_weight_sum;
}

/** The basket in force on calendar day `ymd` for a move on the next day: latest stated on or before it. */
function inForceOnOrBefore(history: CompositePositionsRow[], ymd: string): CompositePositionsRow | null {
  let found: CompositePositionsRow | null = null;
  for (const row of history) {
    if (row.positions_date > ymd) break;
    found = row;
  }
  return found;
}

type DayValue = { usd: number; clp: number };

/** Prices every day of (yearAnchor, today] for one price ticker, plus the anchor itself. */
class HoldingValues {
  private readonly closes = new Map<string, number>();

  constructor(
    private readonly priceTicker: string,
    private readonly today: string,
    private readonly now: Date,
    private readonly fx: (ymd: string) => number
  ) {
    const currency = equityQuoteCurrency(priceTicker);
    if (currency !== "usd") {
      throw new Error(`proxy basket holding ${priceTicker} is quoted in ${currency}; the breakdown prices USD ETFs only`);
    }
  }

  /** USD price on `ymd`: the on-or-before close for a past day, the live / held / EOD resolution for today. */
  private price(ymd: string): number {
    const cached = this.closes.get(ymd);
    if (cached != null) return cached;
    const price = ymd === this.today ? this.todayPrice() : this.pastPrice(ymd);
    this.closes.set(ymd, price);
    return price;
  }

  private pastPrice(ymd: string): number {
    const close = equityCloseEod(this.priceTicker, ymd);
    if (close == null || !Number.isFinite(close) || close <= 0) {
      throw new Error(`proxy basket holding ${this.priceTicker}: no equity_daily close on or before ${ymd}`);
    }
    return close;
  }

  private todayPrice(): number {
    const session = equitySessionYmdForTicker(this.priceTicker, this.now);
    const quote = resolveEquityQuote(this.priceTicker, session, { preferLive: true, now: this.now });
    if (quote != null && Number.isFinite(quote.price) && quote.price > 0) return quote.price;
    const close = equityCloseEod(this.priceTicker, this.today);
    if (close == null || !Number.isFinite(close) || close <= 0) {
      throw new Error(`proxy basket holding ${this.priceTicker}: no quote for today (${this.today}) and no close before it`);
    }
    return close;
  }

  value(ymd: string): DayValue {
    const usd = this.price(ymd);
    return { usd, clp: usd * this.fx(ymd) };
  }
}

type PeriodAccumulator = {
  held: number;
  total: number;
  growth: DayValue;
  contribution: DayValue;
};

function newAccumulator(): PeriodAccumulator {
  return { held: 0, total: 0, growth: { usd: 1, clp: 1 }, contribution: { usd: 0, clp: 0 } };
}

function pctDto(value: DayValue, includeUsd: boolean): NavCardPctDto {
  return { clp: value.clp, usd: includeUsd ? value.usd : null };
}

function nullPct(): NavCardPctDto {
  return { clp: null, usd: null };
}

/**
 * The breakdown of `bucketSlug`'s latest stated basket, or null when the bucket has no stated
 * basket at all (a demo DB). Every other missing input throws.
 */
export function loadProxyBasketBreakdown(
  bucketSlug: string,
  opts: { now?: Date; includeUsd: boolean }
): ProxyBasketBreakdown | null {
  const now = opts.now ?? new Date();
  const today = chileWallClockAt(now).ymd;
  const history = loadPositionsHistory(bucketSlug);
  if (history.length === 0) return null;
  const latest = history[history.length - 1]!;
  const otherWeight = otherWeightFromSleeve(bucketSlug, latest);

  const anchors: Record<CardMetricsPeriod, string> = {
    day: priorPeriodEndYmd("dtd", today),
    month: priorPeriodEndYmd("mtd", today),
    year: priorPeriodEndYmd("ytd", today),
  };
  for (const period of PERIODS) {
    if (anchors[period] >= today) {
      throw new Error(`proxy basket ${bucketSlug}: ${period} anchor ${anchors[period]} is not before today ${today}`);
    }
  }
  // The year window contains the other two (its anchor is the earliest), so one walk serves all.
  const walkStart = chileCalendarAddDays(anchors.year, 1);

  const fxCache = new Map<string, number>();
  const fx = (ymd: string): number => {
    const cached = fxCache.get(ymd);
    if (cached != null) return cached;
    const frame = observadoFrameFxForDay(ymd, now);
    fxCache.set(ymd, frame.clp_per_usd);
    return frame.clp_per_usd;
  };

  const holdings: ProxyHoldingBreakdown[] = [];
  for (const stated of latest.holdings) {
    const priceTicker = FINTUAL_TICKER_PRICE_PROXY[stated.ticker] ?? stated.ticker;
    const values = new HoldingValues(priceTicker, today, now, fx);
    const acc: Record<CardMetricsPeriod, PeriodAccumulator> = {
      day: newAccumulator(),
      month: newAccumulator(),
      year: newAccumulator(),
    };

    let prevDay = anchors.year;
    let prev = values.value(prevDay);
    for (let d = walkStart; d <= today; d = chileCalendarAddDays(d, 1)) {
      const inForce = inForceOnOrBefore(history, prevDay);
      if (inForce == null) {
        throw new Error(
          `proxy basket ${bucketSlug}: the year window starts ${walkStart} but the first stated basket is ${history[0]!.positions_date}`
        );
      }
      const weight = fundWeightIn(bucketSlug, inForce, stated.ticker);
      const cur = values.value(d);
      const r: DayValue = { usd: cur.usd / prev.usd - 1, clp: cur.clp / prev.clp - 1 };
      for (const period of PERIODS) {
        if (d <= anchors[period]) continue;
        const a = acc[period];
        a.total += 1;
        if (weight > 0) {
          a.held += 1;
          a.growth.usd *= 1 + r.usd;
          a.growth.clp *= 1 + r.clp;
          a.contribution.usd += weight * r.usd;
          a.contribution.clp += weight * r.clp;
        }
      }
      prevDay = d;
      prev = cur;
    }

    const pct = {} as Record<CardMetricsPeriod, NavCardPctDto>;
    const contributionPct = {} as Record<CardMetricsPeriod, NavCardPctDto>;
    const daysHeld = {} as Record<CardMetricsPeriod, { held: number; total: number }>;
    for (const period of PERIODS) {
      const a = acc[period];
      const held = a.held > 0;
      pct[period] = held ? pctDto({ usd: a.growth.usd - 1, clp: a.growth.clp - 1 }, opts.includeUsd) : nullPct();
      contributionPct[period] = held ? pctDto(a.contribution, opts.includeUsd) : nullPct();
      daysHeld[period] = { held: a.held, total: a.total };
    }

    holdings.push({
      ticker: stated.ticker,
      price_ticker: priceTicker,
      weight: fundWeightIn(bucketSlug, latest, stated.ticker),
      pct,
      contribution_pct: contributionPct,
      days_held: daysHeld,
    });
  }
  holdings.sort((a, b) => b.weight - a.weight || a.ticker.localeCompare(b.ticker));

  return {
    bucket_slug: bucketSlug,
    positions_date: latest.positions_date,
    other_weight: otherWeight,
    holdings,
  };
}
