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
  if (shouldUseLiveFxQuote(now)) {
    const live = getLatestLiveFxQuoteRow(maxAgeMs);
    if (live && asOfYmd != null && live.session_ymd <= asOfYmd) {
      return { date: live.session_ymd, clp_per_usd: live.value };
    }
  }
  return fxMonthEndForBalanceUsd(asOfYmd);
}

/**
 * Pesos in dollars in the live frame of the day they were marked: the live CLP=X while the
 * mark date's fx day is open, the stored close after. The dashboard row's `current_value_usd`
 * and the performance series' live current-month row both read it, so a card's value and its
 * table's last close are the same dollars (the AFC's mark is dated the previous business day:
 * converted at today's stored row it sat 0,xx USD off the card, 2026-10-27). Null without fx.
 */
export function usdFromClpAtLiveFrame(clp: number, asOfYmd: string | null, now = new Date()): number | null {
  const fx = fxForLiveMtm(asOfYmd, now);
  if (!fx || !(fx.clp_per_usd > 0)) return null;
  const usd = clp / fx.clp_per_usd;
  return Number.isFinite(usd) ? usd : null;
}
