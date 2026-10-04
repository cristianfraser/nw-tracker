/**
 * Backfill `equity_dividends` (cash dividends per share by ex-date) from Yahoo for the
 * benchmark tickers — what a total-return benchmark reinvests. Write-once: ex-dates already
 * stored are left alone, and an amount that disagrees with the stored one throws.
 *
 *   npm run backfill:equity-dividends -w nw-tracker-server -- [--ticker=SPY] [--from=2015-01-01] [--dry-run]
 *
 * Default tickers: every `equity_with_dividends` benchmark. The nightly `stocks_nyse` sync keeps
 * the latest ones current.
 */
import { db } from "../src/db.js";
import { listBenchmarkEquityTickers } from "../src/benchmarkLevels.js";
import { insertEquityDividendsIfMissing } from "../src/equityDividends.js";
import { fetchYahooDailyClosesAndDividends } from "../src/equityYahooEod.js";

function arg(name: string): string | undefined {
  const p = process.argv.find((a) => a.startsWith(`--${name}=`));
  return p ? p.slice(name.length + 3) : undefined;
}

async function main(): Promise<void> {
  const dry = process.argv.includes("--dry-run");
  const from = arg("from") ?? "2015-01-01";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) throw new Error(`--from must be YYYY-MM-DD (got ${from})`);
  const tickers = arg("ticker") ? [arg("ticker")!] : listBenchmarkEquityTickers();
  if (tickers.length === 0) throw new Error("no benchmark equity tickers");
  const period1 = Math.floor(Date.parse(`${from}T00:00:00Z`) / 1000);
  const period2 = Math.floor(Date.now() / 1000);
  for (const ticker of tickers) {
    const { dividends } = await fetchYahooDailyClosesAndDividends(ticker, period1, period2);
    const stored = db
      .prepare(`SELECT COUNT(*) AS n FROM equity_dividends WHERE ticker = ?`)
      .get(ticker) as { n: number };
    const first = dividends[0];
    const last = dividends[dividends.length - 1];
    console.log(
      `${ticker}: Yahoo lists ${dividends.length} dividends (${first?.ex_date ?? "—"} … ${last?.ex_date ?? "—"}), ${stored.n} stored`
    );
    if (dry) continue;
    const { inserted } = insertEquityDividendsIfMissing(ticker, dividends);
    console.log(`${ticker}: inserted ${inserted}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
