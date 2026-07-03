/**
 * Backfill `equity_daily` closes for `.SN` tickers from Bolsa de Santiago point history
 * (~14 months of exchange trading days). For instruments whose history Yahoo does not
 * carry (e.g. CFIETFIPSA.SN).
 *
 * Usage:
 *   npm run backfill:bolsa-santiago-eod -w nw-tracker-server                      # CFIETFIPSA.SN
 *   npm run backfill:bolsa-santiago-eod -w nw-tracker-server -- OTRO.SN           # explicit tickers
 *   npm run backfill:bolsa-santiago-eod -w nw-tracker-server -- --dry-run
 */
import "../src/db.js";
import { upsertEquityDailySeries } from "../src/brokerageEquityMtm.js";
import { fetchBolsaSantiagoDailyCloses } from "../src/equityBolsaSantiagoEod.js";
import { loadRootDotenv } from "./fintualApiLib.js";

const DRY = process.argv.includes("--dry-run");
const argTickers = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const TICKERS = (argTickers.length > 0 ? argTickers : ["CFIETFIPSA.SN"]).map((t) =>
  t.trim().toUpperCase()
);

async function main(): Promise<void> {
  loadRootDotenv();
  console.log(
    `Backfill Bolsa de Santiago EOD into equity_daily (${TICKERS.join(", ")})${DRY ? " [dry-run]" : ""}…`
  );

  let total = 0;
  for (const ticker of TICKERS) {
    process.stderr.write(`${ticker}… `);
    const series = await fetchBolsaSantiagoDailyCloses(ticker);
    const n = DRY ? series.dates.length : upsertEquityDailySeries(ticker, series);
    total += n;
    console.error(
      `${series.dates.length} day(s) [${series.dates[0]} … ${series.dates[series.dates.length - 1]}] (${n} upserted)`
    );
  }

  console.log(`${DRY ? "[dry-run] " : ""}Done. equity_daily: ${total} row(s) from Bolsa de Santiago.`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
