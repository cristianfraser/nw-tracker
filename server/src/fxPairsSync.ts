/**
 * The currency pairs loaded through `currencies` (migration 312): each core currency with a Yahoo
 * pair symbol (EUR: `EURUSD=X`, EUR/USD) gets its daily history in `fx_rates` from the portfolio's
 * start, and its close each fx day. Write-once, like `fx_daily`: a stored day is never revised (a
 * Yahoo daily bar's close disagrees with its intraday feed; the first observation stands). Weekend
 * bars are dropped (Yahoo labels its week-open bar by the New York date it starts on, a Sunday).
 * Yahoo stamps these bars at 00:00 London, so a bar is the London day's: due — and stored — only
 * once that London day has ended (the bar of a day still trading is an unfinished close, and rows
 * are write-once). The sync wakes ten minutes after London midnight.
 */
import { db } from "./db.js";
import { chileCalendarAddDays } from "./chileDate.js";
import { londonWallClock } from "./londonSession.js";
import { fetchYahooDailyCloses } from "./equityYahooEod.js";
import { isWeekendYmd } from "./marketHolidays.js";
import { portfolioStartYmd } from "./portfolioStart.js";

export type LoadedPair = { code: string; base: string; quote: string; yahoo_symbol: string };

/** The pairs `currencies` says to load (core tier only for now). */
export function loadedFxPairs(): LoadedPair[] {
  return (
    db
      .prepare(
        `SELECT code, pair_base AS base, pair_quote AS quote, yahoo_pair_symbol AS yahoo_symbol
           FROM currencies WHERE tier = 'core' AND yahoo_pair_symbol IS NOT NULL ORDER BY code`
      )
      .all() as LoadedPair[]
  );
}

const selLatest = db.prepare(`SELECT MAX(date) AS d FROM fx_rates WHERE base = ? AND quote = ?`);
const selFirst = db.prepare(`SELECT MIN(date) AS d FROM fx_rates WHERE base = ? AND quote = ?`);
const insRate = db.prepare(
  `INSERT OR IGNORE INTO fx_rates (base, quote, date, mid, source) VALUES (?, ?, ?, ?, ?)`
);

export function latestFxPairDate(p: Pick<LoadedPair, "base" | "quote">): string | null {
  return (selLatest.get(p.base, p.quote) as { d: string | null }).d;
}

/** The newest London weekday that has ended: the last bar a pair can have. */
export function fxPairDueYmd(now: Date = new Date()): string {
  let d = chileCalendarAddDays(londonWallClock(now).ymd, -1);
  while (isWeekendYmd(d)) d = chileCalendarAddDays(d, -1);
  return d;
}

/** Ten minutes after the next London midnight. */
export function fxPairsNextSync(now: Date = new Date()): { ymd: string; hour: number; minute: number; timeZone: "Europe/London" } {
  return { ymd: chileCalendarAddDays(londonWallClock(now).ymd, 1), hour: 0, minute: 10, timeZone: "Europe/London" };
}

/** Every loaded pair has its due day (and its history from the portfolio start). */
export function fxPairsCaughtUp(now: Date = new Date()): boolean {
  const due = fxPairDueYmd(now);
  const start = portfolioStartYmd();
  return loadedFxPairs().every((p) => {
    const first = (selFirst.get(p.base, p.quote) as { d: string | null }).d;
    const latest = latestFxPairDate(p);
    return first != null && first <= nextWeekdayOnOrAfter(start) && latest != null && latest >= due;
  });
}

export function isFxPairsStale(opts?: { force?: boolean; now?: Date }): boolean {
  if (opts?.force) return true;
  return !fxPairsCaughtUp(opts?.now ?? new Date());
}

function nextWeekdayOnOrAfter(ymd: string): string {
  let d = ymd;
  while (isWeekendYmd(d)) {
    const t = new Date(`${d}T12:00:00Z`);
    t.setUTCDate(t.getUTCDate() + 1);
    d = t.toISOString().slice(0, 10);
  }
  return d;
}

export type FxPairsSyncResult = { pairs: { code: string; inserted: number; latest: string | null }[] };

/**
 * Fetch and store what each loaded pair is missing: the whole history from the portfolio start
 * when the pair has none, else the days after its latest row, capped at the due fx day (a forced
 * run before the day end never stores the in-progress bar). A close that is not a positive number
 * throws (a source change must surface).
 */
export async function syncFxPairsFromYahoo(opts?: { now?: Date; dryRun?: boolean }): Promise<FxPairsSyncResult> {
  const now = opts?.now ?? new Date();
  const due = fxPairDueYmd(now);
  const out: FxPairsSyncResult["pairs"] = [];
  for (const p of loadedFxPairs()) {
    const latest = latestFxPairDate(p);
    const first = (selFirst.get(p.base, p.quote) as { d: string | null }).d;
    const fromYmd = first == null || first > portfolioStartYmd() ? portfolioStartYmd() : latest!;
    const period1 = Math.floor(new Date(`${fromYmd}T00:00:00Z`).getTime() / 1000) - 3 * 86400;
    const period2 = Math.floor(now.getTime() / 1000) + 86400;
    const series = await fetchYahooDailyCloses(p.yahoo_symbol, period1, period2);
    let inserted = 0;
    db.transaction(() => {
      series.dates.forEach((d, i) => {
        if (isWeekendYmd(d) || d > due || d < portfolioStartYmd()) return;
        const v = series.closes[i];
        if (v == null || !Number.isFinite(v) || !(v > 0)) {
          throw new Error(`fx pair ${p.yahoo_symbol}: close on ${d} is not a positive number (${v})`);
        }
        if (opts?.dryRun) return;
        inserted += insRate.run(p.base, p.quote, d, v, `yahoo:${p.yahoo_symbol}`).changes;
      });
    })();
    out.push({ code: p.code, inserted, latest: latestFxPairDate(p) });
  }
  return { pairs: out };
}
