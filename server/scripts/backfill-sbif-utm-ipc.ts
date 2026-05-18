/**
 * Backfill `utm_daily` and `ipc_daily` from CMF SBIF API year-by-year (from portfolio start through current year).
 *
 * Env: `SBIF_APIKEY` in repo-root `.env`. Optional `PORTFOLIO_START_YMD=YYYY-MM-DD`.
 *
 * Usage:
 *   npm run backfill:sbif-utm-ipc -w nw-tracker-server
 *   npm run backfill:sbif-utm-ipc -w nw-tracker-server -- --dry-run
 */
import "../src/db.js";
import { chileWallClockNow } from "../src/chileDate.js";
import { portfolioStartYmd } from "../src/portfolioStart.js";
import { fetchIpcYear, fetchUtmYear } from "../src/sbifApi.js";
import { upsertIpcRows, upsertUtmRows } from "../src/sbifSyncDb.js";
import { loadRootDotenv } from "./fintualApiLib.js";

const DRY = process.argv.includes("--dry-run");

async function main(): Promise<void> {
  loadRootDotenv();
  const apiKey = process.env.SBIF_APIKEY?.trim() ?? "";
  if (!apiKey) {
    console.error("Set SBIF_APIKEY in .env");
    process.exit(1);
  }
  const startY = parseInt(portfolioStartYmd().slice(0, 4), 10);
  const endY = chileWallClockNow().year;
  if (!Number.isFinite(startY) || startY < 1990) {
    console.error("Invalid portfolio start year");
    process.exit(1);
  }

  let utmTotal = 0;
  let ipcTotal = 0;
  for (let y = startY; y <= endY; y++) {
    process.stderr.write(`UTM ${y}… `);
    const utm = await fetchUtmYear(y, apiKey);
    utmTotal += upsertUtmRows(utm, DRY);
    console.error(`${utm.length} rows`);

    process.stderr.write(`IPC ${y}… `);
    const ipc = await fetchIpcYear(y, apiKey);
    ipcTotal += upsertIpcRows(ipc, DRY);
    console.error(`${ipc.length} rows`);
  }

  console.log(`${DRY ? "[dry-run] " : ""}Done. UTM rows upserted: ${utmTotal}, IPC: ${ipcTotal} (years ${startY}–${endY}).`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
