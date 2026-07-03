/**
 * Backfill long Yahoo daily history into `equity_daily` for every watchlist equity/crypto
 * ticker (top-level rows + RN proxy composite constituents). The per-request watchlist
 * backfill only reaches ~400 days; multi-year anchors (3y/5y/10y) need this deeper pull.
 *
 * Santiago (`.SN`) tickers are skipped — Yahoo has no history for them; use
 * `backfill:bolsa-santiago-eod` instead.
 *
 * Usage:
 *   npm run backfill:watchlist-equity-history -w nw-tracker-server
 *   npm run backfill:watchlist-equity-history -w nw-tracker-server -- --years 11
 *   npm run backfill:watchlist-equity-history -w nw-tracker-server -- --dry-run
 */
import "../src/db.js";
import { upsertEquityDailySeries } from "../src/brokerageEquityMtm.js";
import { equityMarketKind } from "../src/equityQuote.js";
import { fetchYahooRecentDailyCloses, type EodCloseSeries } from "../src/equityYahooEod.js";
import { utcTodayYmd } from "../src/nyseSession.js";
import { listWatchlistEquitySeriesKeys, syncWatchlistFromApp } from "../src/watchlist.js";

const DRY = process.argv.includes("--dry-run");

function parseYears(): number {
  const i = process.argv.indexOf("--years");
  if (i >= 0) {
    const y = Number(process.argv[i + 1]);
    if (!Number.isFinite(y) || y <= 0 || y > 30) {
      throw new Error(`--years must be a positive number ≤ 30 (got ${process.argv[i + 1]})`);
    }
    return y;
  }
  return 11;
}

async function main(): Promise<void> {
  const years = parseYears();
  const days = Math.ceil(years * 366);
  syncWatchlistFromApp();
  const tickers = listWatchlistEquitySeriesKeys().filter((t) => equityMarketKind(t) !== "santiago");

  console.log(
    `Backfill ${years}y Yahoo EOD into equity_daily for ${tickers.length} watchlist ticker(s)${DRY ? " [dry-run]" : ""}…`
  );

  // Crypto trades 24/7, so Yahoo returns a live partial bar for the in-progress UTC day.
  // EOD must only store completed UTC days (the crypto_eod sync writes today's close later).
  const todayUtc = utcTodayYmd();
  function dropInProgressCryptoDay(ticker: string, series: EodCloseSeries): EodCloseSeries {
    if (equityMarketKind(ticker) !== "crypto24") return series;
    const keep = series.dates.map((d) => d < todayUtc);
    return {
      dates: series.dates.filter((_, i) => keep[i]),
      closes: series.closes.filter((_, i) => keep[i]),
    };
  }

  let total = 0;
  for (const ticker of tickers) {
    process.stderr.write(`${ticker}… `);
    try {
      const series = dropInProgressCryptoDay(ticker, await fetchYahooRecentDailyCloses(ticker, days));
      const n = DRY ? series.dates.length : upsertEquityDailySeries(ticker, series);
      total += n;
      const range = series.dates.length
        ? `[${series.dates[0]} … ${series.dates[series.dates.length - 1]}]`
        : "[no bars]";
      console.error(`${series.dates.length} day(s) ${range} (${n} upserted)`);
    } catch (e) {
      console.error(`FAILED: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  console.log(`${DRY ? "[dry-run] " : ""}Done. equity_daily: ${total} row(s) from Yahoo (${years}y).`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
