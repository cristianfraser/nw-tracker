/**
 * Refresh the demo's committed Bolsa de Santiago snapshot (`server/data/demo/santiago-closes.csv`):
 * every `.SN` ticker the demo holds, from the exchange's own point history, through yesterday
 * (Chile). Run from a machine that reaches www.bolsadesantiago.com (the laptop, the home
 * server — Render's servers cannot), commit the file and push `main` before releasing the demo:
 * the Render build refuses a snapshot older than DEMO_SANTIAGO_SNAPSHOT_MAX_AGE_DAYS.
 *
 *   npm run demo:refresh-santiago-snapshot -w nw-tracker-server
 */
import { readFileSync, writeFileSync } from "node:fs";
import { chileCalendarAddDays, chileCalendarTodayYmd } from "../src/chileDate.js";
import { DEMO_TICKERS } from "../src/demoData/market.js";
import {
  DEMO_SANTIAGO_SNAPSHOT_CSV_PATH,
  parseDemoSantiagoSnapshotCsv,
} from "../src/demoData/demoRealMarket.js";
import { fetchBolsaSantiagoDailyCloses } from "../src/equityBolsaSantiagoEod.js";
import { equityQuoteCurrency } from "../src/equityQuote.js";

async function main(): Promise<void> {
  const yesterday = chileCalendarAddDays(chileCalendarTodayYmd(), -1);
  const tickers = DEMO_TICKERS.map((t) => t.ticker).filter((t) => equityQuoteCurrency(t) === "clp");
  if (tickers.length === 0) throw new Error("demo: no Santiago ticker to refresh");
  const before = parseDemoSantiagoSnapshotCsv(readFileSync(DEMO_SANTIAGO_SNAPSHOT_CSV_PATH, "utf8"));
  const lines = ["ticker;day;close_clp"];
  for (const ticker of tickers) {
    const series = await fetchBolsaSantiagoDailyCloses(ticker);
    let rows = 0;
    series.dates.forEach((d, i) => {
      if (d > yesterday) return;
      const close = series.closes[i]!;
      if (!(close > 0)) throw new Error(`demo: ${ticker} ${d} close ${close} is not positive`);
      lines.push(`${ticker};${d};${Number(close.toFixed(2))}`);
      rows += 1;
    });
    const prev = before.get(ticker);
    console.log(
      `${ticker}: ${rows} rows ${series.dates[0]} → ${lines.at(-1)!.split(";")[1]}` +
        (prev ? ` (was ${prev.dates.length} rows through ${prev.dates.at(-1)})` : " (new)")
    );
  }
  // Re-read what we are about to write: the parser's own rules are the file's contract.
  parseDemoSantiagoSnapshotCsv(`${lines.join("\n")}\n`);
  writeFileSync(DEMO_SANTIAGO_SNAPSHOT_CSV_PATH, `${lines.join("\n")}\n`);
  console.log(`wrote ${DEMO_SANTIAGO_SNAPSHOT_CSV_PATH}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
