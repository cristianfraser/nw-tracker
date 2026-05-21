/**
 * Backfill `utm_daily` and `ipc_daily` from Banco Central BDE API year-by-year.
 *
 * Env: `BCENTRAL_EMAIL`, `BCENTRAL_PASSWORD` in repo-root `.env`. Optional `PORTFOLIO_START_YMD=YYYY-MM-DD`.
 *
 * Usage:
 *   npm run backfill:sbif-utm-ipc -w nw-tracker-server
 *   npm run backfill:sbif-utm-ipc -w nw-tracker-server -- --dry-run
 */
import "../src/db.js";
import { chileWallClockNow } from "../src/chileDate.js";
import { fetchIpcYear, fetchUtmYear, loadBcentralCredentials } from "../src/bcentralApi.js";
import { portfolioStartYmd } from "../src/portfolioStart.js";
import { upsertIpcRows, upsertUtmRows } from "../src/sbifSyncDb.js";
import { loadRootDotenv } from "./fintualApiLib.js";

const DRY = process.argv.includes("--dry-run");

async function main(): Promise<void> {
  loadRootDotenv();
  const creds = loadBcentralCredentials();
  if (!creds) {
    console.error("Set BCENTRAL_EMAIL and BCENTRAL_PASSWORD in .env");
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
    const utm = await fetchUtmYear(y, creds);
    utmTotal += upsertUtmRows(utm, DRY);
    console.error(`${utm.length} rows`);

    process.stderr.write(`IPC ${y}… `);
    const ipc = await fetchIpcYear(y, creds);
    ipcTotal += upsertIpcRows(ipc, DRY);
    console.error(`${ipc.length} rows`);
  }

  console.log(`${DRY ? "[dry-run] " : ""}Done. UTM rows upserted: ${utmTotal}, IPC: ${ipcTotal} (years ${startY}–${endY}).`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
