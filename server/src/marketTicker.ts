import { AFP_UNO_CUOTA_SERIES_KEY } from "./afpQuetalmiApi.js";
import {
  latestAfpUnoFundUnitRowOnOrBeforeForDisplay,
  priorAfpUnoFundUnitRowBeforeForDisplay,
} from "./afpUnoValuation.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { db } from "./db.js";
import { equitySessionYmdForTicker, resolveEquityQuote } from "./equityQuote.js";
import { fxRowOnOrBefore } from "./fxRates.js";

const EQUITY_TICKER_ORDER = ["SPY", "VEA", "BTC-USD", "ETH-USD"] as const;

const stmtUfOnOrBefore = db.prepare(
  `SELECT date, clp_per_uf FROM uf_daily WHERE date <= ? ORDER BY date DESC LIMIT 1`
);
const stmtFxPriorTo = db.prepare(
  `SELECT clp_per_usd FROM fx_daily WHERE date < ? ORDER BY date DESC LIMIT 1`
);

function percentChange(live: number, prior: number | null | undefined): number | null {
  if (prior == null || !Number.isFinite(prior) || prior === 0 || !Number.isFinite(live)) return null;
  return ((live - prior) / prior) * 100;
}

function sortEquityTickers(tickers: string[]): string[] {
  const uniq = [...new Set(tickers)];
  return uniq.sort((a, b) => {
    const ia = (EQUITY_TICKER_ORDER as readonly string[]).indexOf(a);
    const ib = (EQUITY_TICKER_ORDER as readonly string[]).indexOf(b);
    if (ia >= 0 && ib >= 0) return ia - ib;
    if (ia >= 0) return -1;
    if (ib >= 0) return 1;
    return a.localeCompare(b);
  });
}

export type MarketTickerEquityRow = {
  ticker: string;
  trade_date: string;
  value_usd: number;
  delta_pct: number | null;
  source: "live" | "eod";
};

export type MarketTickerPayload = {
  chile_today: string;
  uf: { date: string; clp_per_uf: number } | null;
  usd: { date: string; clp_per_usd: number; delta_pct: number | null } | null;
  uno_a: { day: string; unit_value_clp: number; delta_pct: number | null } | null;
  equities: MarketTickerEquityRow[];
};

/**
 * Marquee snapshot for Chile today: UF/USD from DB; equities from Yahoo live when session open else EOD.
 */
export async function getMarketTickerPayload(): Promise<MarketTickerPayload> {
  const today = chileCalendarTodayYmd();
  const now = new Date();

  const ufRow = stmtUfOnOrBefore.get(today) as { date: string; clp_per_uf: number } | undefined;
  const uf =
    ufRow != null && Number.isFinite(ufRow.clp_per_uf) && ufRow.clp_per_uf > 0
      ? { date: ufRow.date, clp_per_uf: ufRow.clp_per_uf }
      : null;

  const fxRow = fxRowOnOrBefore(today);
  let usd: MarketTickerPayload["usd"] = null;
  if (fxRow != null && Number.isFinite(fxRow.clp_per_usd) && fxRow.clp_per_usd > 0) {
    const fxStale = fxRow.date < today;
    const prior = fxStale
      ? null
      : (stmtFxPriorTo.get(fxRow.date) as { clp_per_usd: number } | undefined)?.clp_per_usd;
    usd = {
      date: fxRow.date,
      clp_per_usd: fxRow.clp_per_usd,
      delta_pct: fxStale ? 0 : percentChange(fxRow.clp_per_usd, prior),
    };
  }

  const fuRow = latestAfpUnoFundUnitRowOnOrBeforeForDisplay(AFP_UNO_CUOTA_SERIES_KEY, today);
  let uno_a: MarketTickerPayload["uno_a"] = null;
  if (fuRow != null && Number.isFinite(fuRow.unit_value_clp) && fuRow.unit_value_clp > 0) {
    const stale = fuRow.day < today;
    const prior = stale ? null : priorAfpUnoFundUnitRowBeforeForDisplay(AFP_UNO_CUOTA_SERIES_KEY, fuRow.day);
    uno_a = {
      day: fuRow.day,
      unit_value_clp: fuRow.unit_value_clp,
      delta_pct: stale ? 0 : percentChange(fuRow.unit_value_clp, prior?.unit_value_clp),
    };
  }

  const tickersInDb = db
    .prepare(`SELECT DISTINCT ticker FROM equity_daily ORDER BY ticker`)
    .all() as { ticker: string }[];
  const ordered = sortEquityTickers(tickersInDb.map((r) => r.ticker)).filter((t) =>
    (EQUITY_TICKER_ORDER as readonly string[]).includes(t)
  );

  const equities: MarketTickerEquityRow[] = [];
  await Promise.all(
    ordered.map(async (ticker) => {
      const session = equitySessionYmdForTicker(ticker, now);
      const quote = await resolveEquityQuote(ticker, session, { preferLive: true, now });
      if (!quote) return;
      equities.push({
        ticker,
        trade_date: quote.trade_date,
        value_usd: quote.price_usd,
        delta_pct: quote.delta_pct,
        source: quote.source,
      });
    })
  );
  equities.sort(
    (a, b) =>
      (EQUITY_TICKER_ORDER as readonly string[]).indexOf(a.ticker) -
      (EQUITY_TICKER_ORDER as readonly string[]).indexOf(b.ticker)
  );

  return { chile_today: today, uf, usd, uno_a, equities };
}
