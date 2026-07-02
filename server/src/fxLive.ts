import { chileWallClockAt } from "./chileDate.js";
import { fetchYahooLiveQuote } from "./equityYahooEod.js";
import { getLatestLiveFxQuoteRow } from "./liveMarketQuotesDb.js";
import { liveQuotesMaxAgeMs } from "./liveMarketQuotesConfig.js";
import { isNyseRegularSessionOpen } from "./nyseSession.js";
import { fxMonthEndForBalanceUsd, type FxRow } from "./fxRates.js";

/** Yahoo chart symbol: CLP per 1 USD (tipo de cambio observado intraday). */
export const LIVE_FX_YAHOO_SYMBOL = "CLP=X";

/**
 * Use Yahoo intraday USD/CLP while NYSE regular session is open (aligned with live equity MTM).
 * After close, readers use Yahoo CLP=X EOD in `fx_daily`.
 */
export function shouldUseLiveFxQuote(now = new Date()): boolean {
  return isNyseRegularSessionOpen(now);
}

/** Fetch live CLP/USD from Yahoo (scheduler only). */
export async function fetchYahooLiveUsdClpPerUsd(now = new Date()): Promise<{
  clp_per_usd: number;
  session_ymd: string;
  previous_clp_per_usd: number | null;
}> {
  const live = await fetchYahooLiveQuote(LIVE_FX_YAHOO_SYMBOL);
  if (!Number.isFinite(live.price_usd) || live.price_usd <= 0) {
    throw new Error(`Yahoo live CLP=X invalid: ${live.price_usd}`);
  }
  return {
    clp_per_usd: live.price_usd,
    session_ymd: chileWallClockAt(now).ymd,
    previous_clp_per_usd: live.previous_close_usd,
  };
}

/**
 * FX for live MTM / marquee: Yahoo `CLP=X` while NYSE is open; else Yahoo EOD in `fx_daily`.
 */
export function fxForLiveMtm(asOfYmd: string | null, now = new Date(), maxAgeMs = liveQuotesMaxAgeMs()): FxRow | null {
  if (shouldUseLiveFxQuote(now)) {
    const live = getLatestLiveFxQuoteRow(maxAgeMs);
    if (live && asOfYmd != null && live.session_ymd <= asOfYmd) {
      return { date: live.session_ymd, clp_per_usd: live.value };
    }
  }
  return fxMonthEndForBalanceUsd(asOfYmd);
}
