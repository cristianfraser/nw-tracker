import { upsertEquityDailySeries, EQUITY_DAILY_IMPORT_TICKERS } from "./brokerageEquityMtm.js";
import { equityMarketKind } from "./equityQuote.js";
import { fetchYahooRecentDailyCloses } from "./equityYahooEod.js";
import { isNyseTradingDay } from "./marketHolidays.js";
import { isAfterNyseRegularClose, nyseSessionYmd, nyseWallClock, utcTodayYmd } from "./nyseSession.js";
import { clearEquityLiveQuoteCache } from "./equityQuote.js";

export type EquityEodSyncResult = {
  ticker: string;
  rows: number;
  skipped?: string;
};

/**
 * Upsert recent Yahoo daily closes into `equity_daily`.
 * - NYSE (SPY, VEA): only after 16:05 ET on trading days.
 * - Crypto: every run (24/7 market).
 */
export async function syncEquityEodFromYahoo(
  tickers: readonly string[] = EQUITY_DAILY_IMPORT_TICKERS,
  opts?: { dryRun?: boolean; now?: Date; force?: boolean }
): Promise<EquityEodSyncResult[]> {
  const now = opts?.now ?? new Date();
  const dryRun = opts?.dryRun ?? false;
  const force = opts?.force ?? false;
  const out: EquityEodSyncResult[] = [];

  for (const ticker of tickers) {
    const kind = equityMarketKind(ticker);
    if (kind === "nyse") {
      const ny = nyseWallClock(now);
      if (!isNyseTradingDay(ny.ymd)) {
        out.push({ ticker, rows: 0, skipped: "nyse_holiday_or_weekend" });
        continue;
      }
      if (!force && !isAfterNyseRegularClose(now)) {
        out.push({ ticker, rows: 0, skipped: "before_nyse_close" });
        continue;
      }
    }

    try {
      const series = await fetchYahooRecentDailyCloses(ticker, 21);
      const rows = dryRun ? series.dates.length : upsertEquityDailySeries(ticker, series);
      out.push({ ticker, rows });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      out.push({ ticker, rows: 0, skipped: msg.slice(0, 120) });
    }
  }

  if (!dryRun) clearEquityLiveQuoteCache();
  return out;
}

/** NYSE session date to record in sync state after a successful NYSE EOD pull. */
export function equityEodSyncSessionLabel(now = new Date()): {
  nyseSession: string | null;
  cryptoUtcDay: string;
} {
  const ny = nyseWallClock(now);
  return {
    nyseSession: isNyseTradingDay(ny.ymd) ? nyseSessionYmd(now) : null,
    cryptoUtcDay: utcTodayYmd(now),
  };
}
