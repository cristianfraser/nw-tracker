/**
 * Fetch recent equity daily closes into `equity_daily`.
 * NYSE tickers: Yahoo. Crypto: CoinGecko (daily bars including weekends).
 * Prefer `npm run sync:all` (separate `stocks_nyse` and `crypto_eod` buckets).
 *
 * Usage:
 *   npm run sync:equity-eod -w nw-tracker-server
 *   npm run sync:equity-eod -w nw-tracker-server -- --force
 */
import "../src/db.js";
import { listDistinctEquityTickersForSync } from "../src/accountEquityTicker.js";
import { equityMarketKind } from "../src/equityQuote.js";
import { syncCryptoEodFromCoinGecko, syncEquityEodFromYahoo } from "../src/equityEodSync.js";
import { loadRootDotenv } from "./fintualApiLib.js";

const force = process.argv.includes("--force");
const dryRun = process.argv.includes("--dry-run");

async function main(): Promise<void> {
  loadRootDotenv();
  const tickers = listDistinctEquityTickersForSync();
  const stockTickers = tickers.filter((t) => equityMarketKind(t) !== "crypto24");
  const results = [
    ...(stockTickers.length > 0
      ? await syncEquityEodFromYahoo(stockTickers, { dryRun, force })
      : []),
    ...(await syncCryptoEodFromCoinGecko({ dryRun })),
  ];
  for (const r of results) {
    console.log(
      `${r.ticker}: ${r.skipped ? `skip (${r.skipped})` : `${r.rows} row(s) upserted`}`
    );
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
