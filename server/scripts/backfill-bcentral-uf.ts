/**
 * Backfill `uf_daily` (UF valor) from Banco Central BDE API, year-by-year from portfolio
 * start through the current Chile calendar year. UF otherwise only accretes incrementally
 * via the global sync, so historical watchlist anchors (5y/10y) need this one-time pull.
 *
 * Env: `BCENTRAL_EMAIL`, `BCENTRAL_PASSWORD` in repo-root `.env`. Optional `PORTFOLIO_START_YMD=YYYY-MM-DD`.
 *
 * Usage:
 *   npm run backfill:bcentral-uf -w nw-tracker-server
 *   npm run backfill:bcentral-uf -w nw-tracker-server -- --dry-run
 */
import "../src/db.js";
import { chileWallClockNow } from "../src/chileDate.js";
import { fetchUfYear, loadBcentralCredentials } from "../src/bcentralApi.js";
import { portfolioStartYmd } from "../src/portfolioStart.js";
import { upsertUfRows } from "../src/sbifSyncDb.js";
import { loadRootDotenv } from "./fintualApiLib.js";

const DRY = process.argv.includes("--dry-run");

async function main(): Promise<void> {
  loadRootDotenv();
  const creds = loadBcentralCredentials();
  if (!creds) {
    console.error("Set BCENTRAL_EMAIL and BCENTRAL_PASSWORD in .env");
    process.exit(1);
  }
  const startYmd = portfolioStartYmd();
  const startY = parseInt(startYmd.slice(0, 4), 10);
  const endY = chileWallClockNow().year;
  if (!Number.isFinite(startY) || startY < 1990) {
    console.error("Invalid portfolio start year");
    process.exit(1);
  }

  console.log(`Backfill BCentral UF into uf_daily from ${startYmd} (years ${startY}–${endY})${DRY ? " [dry-run]" : ""}…`);

  let total = 0;
  for (let y = startY; y <= endY; y++) {
    process.stderr.write(`UF ${y}… `);
    const rows = (await fetchUfYear(y, creds)).filter((r) => r.date >= startYmd);
    const n = upsertUfRows(rows, DRY);
    total += n;
    console.error(`${rows.length} rows (${n} upserted)`);
  }

  console.log(`${DRY ? "[dry-run] " : ""}Done. uf_daily: ${total} row(s) from Banco Central (from ${startYmd}).`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
