import { noteLiveFxRead } from "./cacheDependencies.js";
import { chileWallClockAt } from "./chileDate.js";
import { fetchYahooLiveQuote } from "./equityYahooEod.js";
import { getLatestLiveFxQuoteRow } from "./liveMarketQuotesDb.js";
import { liveQuotesMaxAgeMs } from "./liveMarketQuotesConfig.js";
import { isFxDayOpen } from "./forexDay.js";
import { fxMonthEndForBalanceUsd, type FxRow } from "./fxRates.js";

/** Yahoo chart symbol: CLP per 1 USD (tipo de cambio observado intraday). */
export const LIVE_FX_YAHOO_SYMBOL = "CLP=X";

/**
 * Use Yahoo intraday USD/CLP while the fx day is open — a weekday before its 17:05 New York end
 * (`forexDay.ts`; US and Chilean holidays included). After that, and on weekends, readers use the
 * stored close in `fx_daily`, which the sync writes from the same quote the readers froze on.
 */
export function shouldUseLiveFxQuote(now = new Date()): boolean {
  // Reported whatever the answer: a figure built on the stored close must go when the fx day
  // opens and the first tick moves the rate (`cacheDependencies.ts`).
  noteLiveFxRead();
  return isFxDayOpen(now);
}

/** Fetch live CLP/USD from Yahoo (scheduler only). */
export async function fetchYahooLiveUsdClpPerUsd(now = new Date()): Promise<{
  clp_per_usd: number;
  session_ymd: string;
  previous_clp_per_usd: number | null;
}> {
  const live = await fetchYahooLiveQuote(LIVE_FX_YAHOO_SYMBOL);
  if (!Number.isFinite(live.price) || live.price <= 0) {
    throw new Error(`Yahoo live CLP=X invalid: ${live.price}`);
  }
  return {
    clp_per_usd: live.price,
    session_ymd: chileWallClockAt(now).ymd,
    previous_clp_per_usd: live.previous_close,
  };
}

/**
 * FX for live MTM / marquee: the stored live `CLP=X` row while the fx day is open; else the
 * `fx_daily` close on or before the date.
 */
export function fxForLiveMtm(asOfYmd: string | null, now = new Date(), maxAgeMs = liveQuotesMaxAgeMs()): FxRow | null {
  // A live row applies only to a date on or after its session (the Chile day it was fetched),
  // and only while fresh: fetched after `Date.now() - maxAgeMs`. A date before that instant's
  // Chile day can match no fresh row, now or after any later tick, so it reads the stored close
  // without reporting a live read — a tick that moves the dollar keeps what it built.
  if (asOfYmd != null && asOfYmd < chileWallClockAt(new Date(Date.now() - maxAgeMs)).ymd) {
    return fxMonthEndForBalanceUsd(asOfYmd);
  }
  if (shouldUseLiveFxQuote(now)) {
    const live = getLatestLiveFxQuoteRow(maxAgeMs);
    if (live && asOfYmd != null && live.session_ymd <= asOfYmd) {
      return { date: live.session_ymd, clp_per_usd: live.value };
    }
  }
  return fxMonthEndForBalanceUsd(asOfYmd);
}
