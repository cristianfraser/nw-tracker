/**
 * Time the Pasivos requests cold, warm and after a simulated live-quote tick, through an
 * in-process server (the real routes, background jobs and the warmer off).
 *
 *   npx tsx scripts/measure-pasivos-tick.ts --db=/abs/copy.db [--at=YYYY-MM-DDTHH:MM] [--rounds=3]
 *
 * Works on a COPY: it deletes the stored equity / fx closes from the measured day on (so the
 * live quotes price it, as during a session) and writes `live_market_quotes`. Refuses
 * `server/data/nw-tracker.db`. The clock is shifted to `--at` (New York wall time, default the
 * latest weekday 14:00 before today) for the whole process, so the NYSE session and the fx day are
 * open and both a coin-only tick and a tick that moves the dollar can be simulated.
 *
 * Ticks: `coin` moves only crypto tickers (scoped invalidation), `fx` moves every price and the
 * dollar. Requests are sent one after another, as a page whose cache was dropped pays them.
 */
import { copyFileSync, existsSync, rmSync } from "node:fs";
import path from "node:path";

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const dbArg = arg("db");
if (!dbArg) throw new Error("--db=/abs/path/to/a/copy.db is required");
const source = path.resolve(dbArg);
if (path.basename(source) === "nw-tracker.db") throw new Error("refusing to run on the live DB; pass a copy");
const work = `${source}.measure.db`;
for (const sfx of ["", "-wal", "-shm"]) if (existsSync(work + sfx)) rmSync(work + sfx);
copyFileSync(source, work);
const rounds = Number(arg("rounds") ?? 3);

// --- Shift the clock before anything reads it.
const RealDate = Date;
function defaultAt(): number {
  // Latest weekday before today, 14:00 New York (EDT/EST: a 4–5 h offset; 18:30 UTC lands inside).
  const d = new RealDate();
  d.setUTCDate(d.getUTCDate() - 1);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() - 1);
  return RealDate.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 18, 30);
}
const atArg = arg("at");
const target = atArg ? RealDate.parse(`${atArg}:00-04:00`) : defaultAt();
let offset = target - RealDate.now();
class ShiftedDate extends RealDate {
  constructor(...a: unknown[]) {
    if (a.length === 0) super(RealDate.now() + offset);
    else super(...(a as [string]));
  }
  static now(): number {
    return RealDate.now() + offset;
  }
}
(globalThis as { Date: DateConstructor }).Date = ShiftedDate as unknown as DateConstructor;

process.env.NW_TRACKER_TEST_DB = work;
process.env.BACKGROUND_JOBS_ENABLED = "0";
process.env.CACHE_WARM_ENABLED = "0";
process.env.USAGE_LOG_ENABLED = "0";
process.env.PORT = process.env.PORT ?? "3987";
process.env.HOST = "127.0.0.1";

const { db } = await import("../src/db.js");
const { chileCalendarTodayYmd } = await import("../src/chileDate.js");
const day = chileCalendarTodayYmd();
db.prepare(`DELETE FROM equity_daily WHERE trade_date >= ?`).run(day);
db.prepare(`DELETE FROM fx_daily WHERE date >= ?`).run(day);
db.prepare(`DELETE FROM live_market_quotes`).run();

const { insertLiveMarketQuote } = await import("../src/liveMarketQuotesDb.js");
const { LIVE_FX_SYMBOL } = await import("../src/liveMarketQuotesConfig.js");
const { equityMarketKind, marketQuoteCurrency } = await import("../src/equityQuote.js");
const { invalidateMarketDataAggregations, clearAggregationCache } = await import("../src/aggregationCache.js");

let step = 0;
/** A poll: every ticker `factor(ticker)` × its last close, the dollar × `fxFactor`. */
function writeQuotes(factor: (t: string) => number, fxFactor: number): Set<string> {
  step += 1;
  const at = new Date();
  const moved = new Set<string>();
  const tickers = (db.prepare(`SELECT DISTINCT ticker FROM equity_daily WHERE currency != 'none'`).all() as {
    ticker: string;
  }[]).map((r) => r.ticker);
  for (const ticker of tickers) {
    const last = db
      .prepare(`SELECT close FROM equity_daily WHERE ticker = ? AND trade_date < ? ORDER BY trade_date DESC LIMIT 1`)
      .get(ticker, day) as { close: number } | undefined;
    if (!last) continue;
    const f = factor(ticker) ** step;
    if (factor(ticker) !== 1) moved.add(ticker.toUpperCase());
    insertLiveMarketQuote({
      symbol: ticker.toUpperCase(),
      kind: "equity",
      value: last.close * f,
      currency: marketQuoteCurrency(ticker),
      session_ymd: equityMarketKind(ticker) === "crypto24" ? at.toISOString().slice(0, 10) : day,
      previous_value: last.close,
      fetched_at: at.toISOString(),
    });
  }
  const fx = db.prepare(`SELECT clp_per_usd FROM fx_daily WHERE date < ? ORDER BY date DESC LIMIT 1`).get(day) as {
    clp_per_usd: number;
  };
  insertLiveMarketQuote({
    symbol: LIVE_FX_SYMBOL,
    kind: "fx_clp_per_usd",
    value: fx.clp_per_usd * fxFactor ** step,
    currency: null,
    session_ymd: day,
    previous_value: fx.clp_per_usd,
    fetched_at: at.toISOString(),
  });
  return moved;
}

writeQuotes(() => 1, 1);
await import("../src/index.js");
await new Promise((r) => setTimeout(r, 500));

const base = `http://127.0.0.1:${process.env.PORT}`;
const PATHS = [
  "/api/meta/sidebar-nav",
  "/api/dashboard/nav-context",
  "/api/accounts?portfolio_group=liabilities",
  "/api/dashboard/valuation-timeseries?portfolio_group=liabilities",
  "/api/groups/liabilities/performance-monthly",
  "/api/portfolio-groups/liabilities/cc-ledger",
  "/api/portfolio-groups/liabilities/mortgage-ledger",
  "/api/daily-series?portfolio_group=liabilities&days=1096",
];

async function timeAll(label: string): Promise<number> {
  const parts: string[] = [];
  let total = 0;
  for (const p of PATHS) {
    const t0 = performance.now();
    const res = await fetch(base + p);
    const body = await res.arrayBuffer();
    const ms = performance.now() - t0;
    if (!res.ok) throw new Error(`${p}: HTTP ${res.status} ${Buffer.from(body).toString().slice(0, 200)}`);
    total += ms;
    parts.push(`${p.replace(/^\/api\//, "").slice(0, 34).padEnd(34)} ${ms.toFixed(0).padStart(6)} ms ${(body.byteLength / 1024).toFixed(0).padStart(5)} KB`);
  }
  console.log(`\n${label}: ${total.toFixed(0)} ms`);
  for (const p of parts) console.log(`  ${p}`);
  return total;
}

const isCoin = (t: string) => equityMarketKind(t) === "crypto24";
const results: Record<string, number[]> = { cold: [], warm: [], coin: [], fx: [] };
for (let r = 0; r < rounds; r++) {
  clearAggregationCache();
  results.cold!.push(await timeAll(`round ${r + 1} cold`));
  results.warm!.push(await timeAll(`round ${r + 1} warm`));
  offset += 60_000;
  const coins = writeQuotes((t) => (isCoin(t) ? 1.01 : 1), 1);
  invalidateMarketDataAggregations("live_tail", { tickers: coins, fx: false });
  results.coin!.push(await timeAll(`round ${r + 1} after a coin-only tick`));
  offset += 60_000;
  const all = writeQuotes(() => 1.01, 1.002);
  invalidateMarketDataAggregations("live_tail", { tickers: all, fx: true });
  results.fx!.push(await timeAll(`round ${r + 1} after a tick that moves the dollar`));
}
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
console.log("\nmedian totals (one after another):");
for (const [k, xs] of Object.entries(results)) console.log(`  ${k.padEnd(5)} ${median(xs).toFixed(0)} ms`);
process.exit(0);
