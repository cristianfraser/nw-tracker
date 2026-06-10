/**
 * Backfill `fx_daily` (Yahoo CLP=X EOD) from portfolio start through today.
 *
 * Usage:
 *   npm run backfill:yahoo-fx-usd -w nw-tracker-server
 *   npm run backfill:yahoo-fx-usd -w nw-tracker-server -- --dry-run
 */
import "../src/db.js";
import { chileWallClockNow } from "../src/chileDate.js";
import { yahooChartPeriodSeconds } from "../src/equityYahooEod.js";
import { fetchYahooFxUsdDailyCloses } from "../src/fxYahooEodSync.js";
import { portfolioStartYmd } from "../src/portfolioStart.js";
import { upsertFxRows } from "../src/sbifSyncDb.js";

const DRY = process.argv.includes("--dry-run");

async function main(): Promise<void> {
  const startYmd = portfolioStartYmd();
  const endYmd = chileWallClockNow().ymd;
  const startY = parseInt(startYmd.slice(0, 4), 10);
  const endY = parseInt(endYmd.slice(0, 4), 10);
  if (!Number.isFinite(startY) || startY < 1990) {
    console.error("Invalid portfolio start year");
    process.exit(1);
  }

  console.log(`Backfill Yahoo CLP=X EOD into fx_daily from ${startYmd} (years ${startY}–${endY})${DRY ? " [dry-run]" : ""}…`);

  let total = 0;
  for (let y = startY; y <= endY; y++) {
    const chunkStart = y === startY ? startYmd : `${y}-01-01`;
    const chunkEnd = y === endY ? endYmd : `${y}-12-31`;
    process.stderr.write(`${y}… `);
    const { period1, period2 } = yahooChartPeriodSeconds(chunkStart, chunkEnd);
    const rows = await fetchYahooFxUsdDailyCloses(period1, period2);
    const n = upsertFxRows(rows, DRY);
    total += n;
    console.error(`${rows.length} rows (${n} upserted)`);
  }

  console.log(`${DRY ? "[dry-run] " : ""}Done. fx_daily: ${total} row(s) from Yahoo CLP=X (from ${startYmd}).`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
