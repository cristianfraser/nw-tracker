/**
 * Fetch recent Yahoo daily closes into `equity_daily` (SPY, VEA, BTC-USD, ETH-USD).
 * Prefer `npm run sync:all` (separate `stocks_nyse` and `crypto_eod` buckets).
 *
 * Usage:
 *   npm run sync:equity-eod -w nw-tracker-server
 *   npm run sync:equity-eod -w nw-tracker-server -- --force
 */
import "../src/db.js";
import { EQUITY_DAILY_IMPORT_TICKERS, syncEquityEodFromYahoo } from "../src/equityEodSync.js";
import { loadRootDotenv } from "./fintualApiLib.js";

const force = process.argv.includes("--force");
const dryRun = process.argv.includes("--dry-run");

async function main(): Promise<void> {
  loadRootDotenv();
  const results = await syncEquityEodFromYahoo(EQUITY_DAILY_IMPORT_TICKERS, { dryRun, force });
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
