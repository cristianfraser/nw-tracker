/**
 * Backfill `utm_daily` (year by year) and `ipc_daily` (one verified range: each month's index is
 * checked against the published monthly variation) from the Banco Central BDE API.
 *
 * Env: `BCENTRAL_EMAIL`, `BCENTRAL_PASSWORD` in repo-root `.env`. Optional `PORTFOLIO_START_YMD=YYYY-MM-DD`.
 *
 * Usage:
 *   npm run backfill:sbif-utm-ipc -w nw-tracker-server
 *   npm run backfill:sbif-utm-ipc -w nw-tracker-server -- --dry-run
 *   npm run backfill:sbif-utm-ipc -w nw-tracker-server -- --replace-ipc   (delete and reload ipc_daily —
 *     after a rebase, or when the stored rows disagree with the Banco Central)
 */
import "../src/db.js";
import { chileWallClockNow } from "../src/chileDate.js";
import { fetchIpcMonthsVerified, fetchUtmYear, loadBcentralCredentials } from "../src/bcentralApi.js";
import { portfolioStartYmd } from "../src/portfolioStart.js";
import { upsertUtmRows, writeVerifiedIpcRows } from "../src/sbifSyncDb.js";
import { loadRootDotenv } from "./fintualApiLib.js";

const DRY = process.argv.includes("--dry-run");
const REPLACE_IPC = process.argv.includes("--replace-ipc");

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
  for (let y = startY; y <= endY; y++) {
    process.stderr.write(`UTM ${y}… `);
    const utm = await fetchUtmYear(y, creds);
    utmTotal += upsertUtmRows(utm, DRY);
    console.error(`${utm.length} rows`);
  }

  // From the December before the first year, so January's variation is checked too.
  const ipcFrom = `${startY - 1}-12-01`;
  const ipc = await fetchIpcMonthsVerified(creds, ipcFrom, chileWallClockNow().ymd);
  const ipcAdded = writeVerifiedIpcRows(ipc, { replace: REPLACE_IPC, dryRun: DRY });
  console.error(`IPC ${ipc[0]!.date} → ${ipc[ipc.length - 1]!.date}: ${ipc.length} months, variation verified`);

  console.log(
    `${DRY ? "[dry-run] " : ""}Done. UTM rows upserted: ${utmTotal} (years ${startY}–${endY}); ` +
      `IPC: ${ipcAdded} new month(s)${REPLACE_IPC ? " (table replaced)" : ""}.`
  );
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
