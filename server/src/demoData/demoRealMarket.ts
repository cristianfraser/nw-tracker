/**
 * Real market history for the hosted demo (preset `demo`). Before the narrative is generated,
 * the market tables of the fresh demo DB are filled from the same public sources the personal
 * instance syncs from, so the demo's holdings are valued at real prices and the wake-on-visit
 * syncs (`demoMarketActivity.ts`) only ever append the days since:
 *
 * - `equity_daily`: Yahoo daily closes of every ticker the narrative holds (BTC-USD included);
 * - `fx_daily`: Yahoo CLP=X (write-once, like the live frame);
 * - `fx_daily_bcentral` / `eur_daily` / `uf_daily` / `utm_daily` / `ipc_daily`: Banco Central
 *   (`BCENTRAL_EMAIL` / `BCENTRAL_PASSWORD` are required — a Render secret on the demo);
 * - `pension_fund_unit_official` (every AFP, fund A) and the UNO display series: the
 *   Superintendencia de Pensiones; `fund_unit_daily` `afc_cic`: its cesantía CSVs.
 *
 * History stops at yesterday (Chile; the last completed UTC day for crypto): today's close is
 * the live sync's. Every source is retried with backoff for up to ~10 minutes; a source still
 * failing then throws and the boot fails (Render keeps the previous deploy live).
 */
import { AFP_UNO_CUOTA_SERIES_KEY } from "../afpUnoSeries.js";
import { afpDisplayThroughDay, buildAfpDisplayRowsForFund, upsertAfpDisplayRows } from "../afpUnoOfficialSync.js";
import { fetchSpCesantiaYear, upsertAfcCicRows } from "../afcCicSeries.js";
import {
  fetchDolarAfterDate,
  fetchEuroAfterDate,
  fetchIpcMonthsVerified,
  fetchUfAfterDate,
  fetchUtmAfterMonth,
  loadBcentralCredentials,
} from "../bcentralApi.js";
import { upsertEquityDailySeries } from "../brokerageEquityMtm.js";
import { chileCalendarAddDays, chileWallClockAt } from "../chileDate.js";
import { db } from "../db.js";
import { cryptoCompletedUtcYmd } from "../equityEodSync.js";
import { fetchYahooDailyCloses, type EodCloseSeries } from "../equityYahooEod.js";
import { fetchYahooFxUsdDailyCloses } from "../fxYahooEodSync.js";
import {
  insertFxRowsIfMissing,
  upsertEurRows,
  upsertFxBcentralRows,
  upsertUfRows,
  upsertUtmRows,
  writeVerifiedIpcRows,
} from "../sbifSyncDb.js";
import { fetchSpAfpFundUnits, officialPensionFundUnits, upsertSpAfpFundUnits } from "../spAfpFundUnits.js";
import type { DemoNarrative } from "./demoNarrative.js";
import {
  DEMO_AFP_MODELO,
  demoNarrativeTickers,
  marketHistoryFirstMonth,
  type DemoEquitySeries,
} from "./demoWriters.js";

/**
 * Whether the demo's AFP and AFC are cuota ledgers on the Superintendencia's official values
 * (Modelo-A switched into UNO-A, and `afc_cic`). Off: the SP site refuses connections from
 * Render's servers, so the hosted demo cannot fetch them; the demo keeps its synthetic book
 * AFP/AFC until a reachable source exists. The ledger code is kept for that day.
 */
export const DEMO_PENSION_LEDGERS = false;

/** Waits between attempts of one source (≈10 minutes in all), then it throws. */
export const DEMO_MARKET_RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000, 120_000, 180_000, 180_000];

/** The demo's live AFP (its history starts on Modelo, `DEMO_AFP_MODELO`). */
const DEMO_AFP_LIVE = "uno";

type Sleep = (ms: number) => Promise<void>;
const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Runs `fn` until it succeeds, waiting {@link DEMO_MARKET_RETRY_DELAYS_MS} between attempts. */
export async function withDemoMarketRetries<T>(
  label: string,
  fn: () => Promise<T>,
  opts: { delaysMs?: readonly number[]; sleep?: Sleep; log?: (line: string) => void } = {}
): Promise<T> {
  const delays = opts.delaysMs ?? DEMO_MARKET_RETRY_DELAYS_MS;
  const sleep = opts.sleep ?? realSleep;
  const log = opts.log ?? ((line: string) => console.warn(line));
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (attempt >= delays.length) {
        throw new Error(`demo market: ${label} still failing after ${attempt + 1} attempts — ${message}`, { cause: e });
      }
      log(`demo market: ${label} failed (attempt ${attempt + 1}), retrying in ${delays[attempt]! / 1000}s — ${message}`);
      await sleep(delays[attempt]!);
    }
  }
}

function unixSeconds(ymd: string): number {
  return Math.floor(Date.parse(`${ymd}T00:00:00Z`) / 1000);
}

/** Keeps the closes dated on or before `lastYmd` (today's bar belongs to the live sync). */
export function closesThrough(series: EodCloseSeries, lastYmd: string): EodCloseSeries {
  const dates: string[] = [];
  const closes: number[] = [];
  series.dates.forEach((d, i) => {
    if (d <= lastYmd) {
      dates.push(d);
      closes.push(series.closes[i]!);
    }
  });
  return { dates, closes };
}

export type DemoRealMarketSummary = {
  from: string;
  through: string;
  equities: Record<string, number>;
  fx: number;
  bcentral: { usd: number; eur: number; uf: number; utm: number; ipc: number };
  afp_official: number;
  afc: number;
};

/**
 * Fills the market tables for `narrative` from the real sources. Requires an empty market
 * (a fresh demo DB) and Banco Central credentials; throws otherwise.
 */
export async function loadDemoRealMarket(narrative: DemoNarrative, now: Date = new Date()): Promise<DemoRealMarketSummary> {
  const creds = loadBcentralCredentials();
  if (!creds) {
    throw new Error("demo market: set BCENTRAL_EMAIL and BCENTRAL_PASSWORD (Banco Central series for the demo)");
  }
  const stored = (db.prepare(`SELECT COUNT(*) AS n FROM equity_daily`).get() as { n: number }).n;
  if (stored > 0) throw new Error(`demo market: equity_daily already holds ${stored} rows — not a fresh demo DB`);

  const cl = chileWallClockAt(now);
  const yesterday = chileCalendarAddDays(cl.ymd, -1);
  // The market window opens years before the portfolio (watchlist 10Y anchors), so the first
  // month's prior-month marks always find a rate.
  const from = `${marketHistoryFirstMonth(narrative)}-01`;
  const fxFrom = from;
  const p2 = Math.floor(now.getTime() / 1000);

  const equities: Record<string, number> = {};
  for (const ticker of demoNarrativeTickers(narrative)) {
    const last = ticker.endsWith("-USD") ? cryptoCompletedUtcYmd(now) : yesterday;
    const series = await withDemoMarketRetries(`Yahoo ${ticker}`, async () => {
      const s = closesThrough(await fetchYahooDailyCloses(ticker, unixSeconds(from), p2), last);
      if (s.dates.length === 0) throw new Error(`no closes for ${ticker}`);
      return s;
    });
    const firstBuy = narrative.stocks ? `${narrative.stocks.from}-01` : `${narrative.firstMonth}-01`;
    if (series.dates[0]! > firstBuy) {
      throw new Error(`demo market: ${ticker} history starts ${series.dates[0]}, after the first buy month ${firstBuy}`);
    }
    equities[ticker] = upsertEquityDailySeries(ticker, series);
  }

  const fxRows = await withDemoMarketRetries("Yahoo CLP=X", async () => {
    const rows = (await fetchYahooFxUsdDailyCloses(unixSeconds(fxFrom), p2)).filter((r) => r.date <= yesterday);
    if (rows.length === 0) throw new Error("no CLP=X closes");
    return rows;
  });
  const fx = insertFxRowsIfMissing(fxRows);

  const ufEnd = chileCalendarAddDays(cl.ymd, 45); // the UF is published up to the 9th of next month
  const usd = await withDemoMarketRetries("Banco Central USD", () => fetchDolarAfterDate(chileCalendarAddDays(fxFrom, -1), creds, yesterday));
  const eur = await withDemoMarketRetries("Banco Central EUR", () => fetchEuroAfterDate(chileCalendarAddDays(fxFrom, -1), creds, yesterday));
  const uf = await withDemoMarketRetries("Banco Central UF", () => fetchUfAfterDate(chileCalendarAddDays(fxFrom, -1), creds, ufEnd));
  const [fy, fm] = fxFrom.split("-").map(Number) as [number, number];
  const utm = await withDemoMarketRetries("Banco Central UTM", () => fetchUtmAfterMonth(fy, fm, creds, ufEnd));
  const ipc = await withDemoMarketRetries("Banco Central IPC", () => fetchIpcMonthsVerified(creds, `${fxFrom.slice(0, 7)}-01`, cl.ymd));
  for (const [name, rows, first] of [
    ["USD", usd, usd[0]?.date],
    ["EUR", eur, eur[0]?.date],
    ["UF", uf, uf[0]?.date],
  ] as const) {
    if (rows.length === 0 || first! > chileCalendarAddDays(fxFrom, 10)) {
      throw new Error(`demo market: Banco Central ${name} starts ${first ?? "nowhere"}, expected from ${fxFrom}`);
    }
  }
  upsertFxBcentralRows(usd, false);
  upsertEurRows(eur, false);
  upsertUfRows(uf, false);
  upsertUtmRows(utm, false);
  writeVerifiedIpcRows(ipc, { replace: false, dryRun: false });

  // AFP / AFC: the Superintendencia's official values, when the host can reach its site.
  // Render's servers cannot (every request fails at the connection, 2026-10-31), so the hosted
  // demo keeps its synthetic book AFP/AFC (`DEMO_PENSION_LEDGERS`).
  let afpOfficial = 0;
  let afc = 0;
  if (DEMO_PENSION_LEDGERS) {
    // AFP: every AFP's official fund A values since the narrative starts; UNO's display series
    // (the live account's) through the day its latest value shows. Modelo's display rows are
    // written by the generator over the window the demo holds it.
    const firstYear = Number(narrative.firstMonth.slice(0, 4));
    const afpRows = await withDemoMarketRetries("Superintendencia AFP fund A", () =>
      fetchSpAfpFundUnits("A", firstYear, cl.year, cl.ymd)
    );
    for (const afp of [DEMO_AFP_MODELO, DEMO_AFP_LIVE]) {
      if (!afpRows.some((r) => r.afp === afp)) throw new Error(`demo market: the SP AFP file carries no ${afp} column`);
    }
    upsertSpAfpFundUnits(afpRows, { dryRun: false });
    const unoOfficial = officialPensionFundUnits(DEMO_AFP_LIVE, "A");
    const unoDisplay = buildAfpDisplayRowsForFund(
      DEMO_AFP_LIVE,
      "A",
      unoOfficial[0]!.day,
      afpDisplayThroughDay(unoOfficial, cl.ymd)
    );
    upsertAfpDisplayRows(AFP_UNO_CUOTA_SERIES_KEY, DEMO_AFP_LIVE, unoDisplay, false);

    for (let year = firstYear; year <= cl.year; year++) {
      const rows = await withDemoMarketRetries(`Superintendencia AFC ${year}`, () => fetchSpCesantiaYear(year));
      afc += upsertAfcCicRows(rows, { dryRun: false, note: `sp:cesantia|demo-boot|${year}` }).inserted;
    }

    afpOfficial = afpRows.length;
  }

  return {
    from,
    through: yesterday,
    equities,
    fx,
    bcentral: { usd: usd.length, eur: eur.length, uf: uf.length, utm: utm.length, ipc: ipc.length },
    afp_official: afpOfficial,
    afc,
  };
}

/** The stored closes per ticker, as the generator's unit math reads them (replaces the synthetic series). */
export function demoEquitySeriesFromDb(tickers: readonly string[]): DemoEquitySeries {
  const select = db.prepare(`SELECT trade_date, close FROM equity_daily WHERE ticker = ? ORDER BY trade_date`);
  const out: DemoEquitySeries = new Map();
  for (const ticker of tickers) {
    const rows = (select.all(ticker) as { trade_date: string; close: number }[]).map((r) => [r.trade_date, r.close] as [string, number]);
    if (rows.length === 0) throw new Error(`demo market: no stored closes for ${ticker}`);
    out.set(ticker, rows);
  }
  return out;
}
