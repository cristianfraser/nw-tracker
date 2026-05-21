/**
 * Backfill `fx_daily` (dólar observado) and `eur_daily` (euro observado) from Banco Central BDE API,
 * year-by-year from portfolio start through the current Chile calendar year.
 *
 * Env: `BCENTRAL_EMAIL`, `BCENTRAL_PASSWORD` in repo-root `.env`. Optional `PORTFOLIO_START_YMD=YYYY-MM-DD`.
 *
 * Usage:
 *   npm run backfill:sbif-fx-eur -w nw-tracker-server
 *   npm run backfill:sbif-fx-eur -w nw-tracker-server -- --dry-run
 */
import "../src/db.js";
import { chileWallClockNow } from "../src/chileDate.js";
import { fetchDolarYear, fetchEuroYear, loadBcentralCredentials } from "../src/bcentralApi.js";
import { portfolioStartYmd } from "../src/portfolioStart.js";
import { upsertEurRows, upsertFxRows } from "../src/sbifSyncDb.js";
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

  console.log(`Backfill BCentral FX/EUR from ${startYmd} (years ${startY}–${endY})${DRY ? " [dry-run]" : ""}…`);

  let fxTotal = 0;
  let eurTotal = 0;
  for (let y = startY; y <= endY; y++) {
    process.stderr.write(`USD ${y}… `);
    const usd = (await fetchDolarYear(y, creds)).filter((r) => r.date >= startYmd);
    fxTotal += upsertFxRows(usd, DRY);
    console.error(`${usd.length} rows`);

    process.stderr.write(`EUR ${y}… `);
    const eur = (await fetchEuroYear(y, creds)).filter((r) => r.date >= startYmd);
    eurTotal += upsertEurRows(eur, DRY);
    console.error(`${eur.length} rows`);
  }

  console.log(
    `${DRY ? "[dry-run] " : ""}Done. fx_daily: ${fxTotal}, eur_daily: ${eurTotal} (from ${startYmd}).`
  );
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
