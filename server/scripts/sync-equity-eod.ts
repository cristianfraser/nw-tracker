/**
 * Fetch recent Yahoo daily closes into `equity_daily` (SPY, VEA, BTC-USD, ETH-USD).
 * NYSE tickers only after 16:05 America/New_York on trading days; crypto every run.
 *
 * Usage:
 *   npm run sync:equity-eod -w nw-tracker-server
 *   npm run sync:equity-eod -w nw-tracker-server -- --force
 */
import "../src/db.js";
import { syncEquityEodFromYahoo } from "../src/equityEodSync.js";
import { loadRootDotenv } from "./fintualApiLib.js";

const force = process.argv.includes("--force");
const dryRun = process.argv.includes("--dry-run");

async function main(): Promise<void> {
  loadRootDotenv();
  const results = await syncEquityEodFromYahoo(undefined, { dryRun, force });
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
