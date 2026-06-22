/**
 * Backfill `equity_daily` crypto closes (BTC-USD, ETH-USD) from CoinGecko.
 * Public API: past 365 calendar days only.
 *
 * Usage:
 *   npm run backfill:crypto-coingecko-eod -w nw-tracker-server
 *   npm run backfill:crypto-coingecko-eod -w nw-tracker-server -- --dry-run
 */
import "../src/db.js";
import { chileCalendarAddDays, chileWallClockNow } from "../src/chileDate.js";
import { upsertEquityDailySeries } from "../src/brokerageEquityMtm.js";
import { COINGECKO_CRYPTO_TICKERS, fetchCoinGeckoMaxDailyCloses } from "../src/equityCoinGeckoEod.js";
import { loadRootDotenv } from "./fintualApiLib.js";

const DRY = process.argv.includes("--dry-run");

async function main(): Promise<void> {
  loadRootDotenv();
  const endYmd = chileWallClockNow().ymd;
  const startYmd = chileCalendarAddDays(endYmd, -364);
  console.log(
    `Backfill CoinGecko crypto EOD into equity_daily (${startYmd} … ${endYmd})${DRY ? " [dry-run]" : ""}…`
  );

  let total = 0;
  for (const ticker of COINGECKO_CRYPTO_TICKERS) {
    process.stderr.write(`${ticker}… `);
    const series = await fetchCoinGeckoMaxDailyCloses(ticker);
    const filtered: { dates: string[]; closes: number[] } = { dates: [], closes: [] };
    for (let i = 0; i < series.dates.length; i++) {
      const d = series.dates[i]!;
      if (d < startYmd || d > endYmd) continue;
      filtered.dates.push(d);
      filtered.closes.push(series.closes[i]!);
    }
    const n = DRY ? filtered.dates.length : upsertEquityDailySeries(ticker, filtered);
    total += n;
    console.error(`${filtered.dates.length} day(s) (${n} upserted)`);
  }

  console.log(`${DRY ? "[dry-run] " : ""}Done. equity_daily crypto: ${total} row(s) from CoinGecko.`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
