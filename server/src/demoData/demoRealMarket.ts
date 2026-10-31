/**
 * Real market history for the hosted demo (preset `demo`). Before the demo is generated,
 * the market tables of the fresh demo DB are filled from the same public sources the personal
 * instance syncs from, so the demo's holdings are valued at real prices and the wake-on-visit
 * syncs (`demoMarketActivity.ts`) only ever append the days since:
 *
 * - `equity_daily`: Yahoo daily closes of every ticker the demo holds (BTC-USD included);
 * - `fx_daily`: Yahoo CLP=X (write-once, like the live frame);
 * - `fx_daily_bcentral` / `eur_daily` / `uf_daily` / `utm_daily` / `ipc_daily`: Banco Central
 *   (`BCENTRAL_EMAIL` / `BCENTRAL_PASSWORD` are required — a Render secret on the demo);
 * - `pension_fund_unit_official` UNO fund A and the UNO display series: AFP UNO's own API
 *   (`afpUnoApi.ts`; the Superintendencia de Pensiones refuses connections from Render's
 *   servers); Modelo fund A, which the demo holds until 2020, from the committed snapshot of
 *   the SP's official values (`DEMO_AFP_MODELO_CSV_PATH`, 2018-01 → 2020-03 — the fund the
 *   demo leaves in 2020 never changes). The AFC stays a synthetic book account: no source of
 *   the cesantía fund's values answers Render.
 *
 * History stops at yesterday (Chile; the last completed UTC day for crypto): today's close is
 * the live sync's. Every source is retried with backoff for up to ~10 minutes; a source still
 * failing then throws and the boot fails (Render keeps the previous deploy live).
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchUnoFundAHistory, UNO_API_FIRST_DAY } from "../afpUnoApi.js";
import { AFP_UNO_CUOTA_SERIES_KEY } from "../afpUnoSeries.js";
import { afpDisplayThroughDay, buildAfpDisplayRowsForFund, upsertAfpDisplayRows } from "../afpUnoOfficialSync.js";
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
import { listBenchmarkEquityTickers } from "../benchmarkLevels.js";
import { insertEquityDividendsIfMissing } from "../equityDividends.js";
import {
  fetchYahooDailyCloses,
  fetchYahooDailyClosesAndDividends,
  type EodCloseSeries,
} from "../equityYahooEod.js";
import { fetchYahooFxUsdDailyCloses } from "../fxYahooEodSync.js";
import {
  insertFxRowsIfMissing,
  upsertEurRows,
  upsertFxBcentralRows,
  upsertUfRows,
  upsertUtmRows,
  writeVerifiedIpcRows,
} from "../sbifSyncDb.js";
import {
  officialPensionFundUnits,
  upsertSpAfpFundUnits,
  type SpAfpFundUnitRow,
} from "../spAfpFundUnits.js";
/** The AFP the demo's history starts on (switched into UNO later). */
export const DEMO_AFP_MODELO = "modelo";

/** What the demo's market needs: the window's first month and each ticker with its first use day. */
export type DemoMarketSpec = {
  fromMonth: string;
  tickers: readonly { ticker: string; firstUse: string }[];
  withAfp: boolean;
};

/** Waits between attempts of one source (≈10 minutes in all), then it throws. */
export const DEMO_MARKET_RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000, 120_000, 180_000, 180_000];

/** The demo's live AFP (its history starts on Modelo, `DEMO_AFP_MODELO`). */
const DEMO_AFP_LIVE = "uno";

type Sleep = (ms: number) => Promise<void>;
const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The SP's official Modelo fund A values over the window the demo holds it (committed data). */
export const DEMO_AFP_MODELO_CSV_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../data/demo/afp-modelo-fund-a-2018-2020.csv"
);

const MODELO_CSV_HEADER = "afp;fund;day;unit_value_clp";

/**
 * Rows of the Modelo snapshot (`afp;fund;day;unit_value_clp`, plain dot decimals, one row per calendar
 * day ascending). Throws on another header, another AFP or fund, a missing or repeated day, or a
 * value that is not positive.
 */
export function parseDemoAfpModeloCsv(text: string): SpAfpFundUnitRow[] {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines[0] !== MODELO_CSV_HEADER) throw new Error(`demo modelo csv: unexpected header «${lines[0] ?? ""}»`);
  const rows: SpAfpFundUnitRow[] = [];
  for (const line of lines.slice(1)) {
    const cells = line.split(";");
    if (cells.length !== 4) throw new Error(`demo modelo csv: unexpected line «${line}»`);
    const [afp, fund, day, raw] = cells as [string, string, string, string];
    if (afp !== DEMO_AFP_MODELO || fund !== "A") throw new Error(`demo modelo csv: not Modelo fund A «${line}»`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`demo modelo csv: invalid day «${line}»`);
    const prev = rows.at(-1)?.day;
    if (prev != null && day !== chileCalendarAddDays(prev, 1)) {
      throw new Error(`demo modelo csv: ${day} does not follow ${prev}`);
    }
    if (!/^\d+(?:\.\d+)?$/.test(raw)) throw new Error(`demo modelo csv: unreadable value «${line}»`);
    const v = Number(raw);
    if (!(v > 0)) throw new Error(`demo modelo csv: non-positive value «${line}»`);
    rows.push({ afp, fund: "A", day, unit_value_clp: v, provisional: false });
  }
  if (rows.length === 0) throw new Error("demo modelo csv: no rows");
  return rows;
}

/**
 * The demo's pension market: Modelo fund A from the committed snapshot and UNO fund A from UNO's
 * API (retried like the other sources), stored as official values; UNO's display series is
 * written through the day its latest value shows. Modelo's display rows are written by the
 * generator over the window the demo holds it. `fetchUno` is injectable for tests and harnesses.
 */
export async function loadDemoPensionMarket(
  todayYmd: string,
  opts: {
    fetchUno?: (fromDay: string, toDay: string) => Promise<SpAfpFundUnitRow[]>;
    retry?: <T>(label: string, fn: () => Promise<T>) => Promise<T>;
  } = {}
): Promise<{ modelo: number; uno: number; uno_through: string }> {
  const fetchUno = opts.fetchUno ?? ((from: string, to: string) => fetchUnoFundAHistory(from, to));
  const retry = opts.retry ?? withDemoMarketRetries;
  const modelo = parseDemoAfpModeloCsv(readFileSync(DEMO_AFP_MODELO_CSV_PATH, "utf8"));
  const uno = await retry("AFP UNO valor cuota", async () => {
    const rows = await fetchUno(UNO_API_FIRST_DAY, todayYmd);
    if (rows.length === 0) throw new Error("no UNO fund A values");
    return rows;
  });
  if (uno[0]!.day > modelo.at(-1)!.day) {
    throw new Error(`demo market: UNO history starts ${uno[0]!.day}, after the Modelo snapshot ends ${modelo.at(-1)!.day}`);
  }
  upsertSpAfpFundUnits(modelo, { dryRun: false });
  upsertSpAfpFundUnits(uno, { dryRun: false });
  const unoOfficial = officialPensionFundUnits(DEMO_AFP_LIVE, "A");
  const throughDay = afpDisplayThroughDay(unoOfficial, todayYmd);
  const unoDisplay = buildAfpDisplayRowsForFund(DEMO_AFP_LIVE, "A", unoOfficial[0]!.day, throughDay);
  upsertAfpDisplayRows(AFP_UNO_CUOTA_SERIES_KEY, DEMO_AFP_LIVE, unoDisplay, false);
  return { modelo: modelo.length, uno: uno.length, uno_through: throughDay };
}

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
  /** Dividends stored per benchmark ticker (total-return benchmarks reinvest them). */
  dividends: Record<string, number>;
  fx: number;
  bcentral: { usd: number; eur: number; uf: number; utm: number; ipc: number };
  afp_official: number;
};

/**
 * Fills the market tables for `spec` from the real sources. Requires an empty market
 * (a fresh demo DB) and Banco Central credentials; throws otherwise.
 */
export async function loadDemoRealMarket(spec: DemoMarketSpec, now: Date = new Date()): Promise<DemoRealMarketSummary> {
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
  const from = `${spec.fromMonth}-01`;
  const fxFrom = from;
  const p2 = Math.floor(now.getTime() / 1000);

  // Benchmark tickers (the Rentabilidad row's SPY) need their dividends too: a total-return
  // benchmark with no dividend on file refuses to read, and the row shows nothing.
  const benchmarkTickers = new Set(listBenchmarkEquityTickers());
  const tickers: { ticker: string; firstUse: string | null }[] = [...spec.tickers];
  for (const t of benchmarkTickers) {
    if (!tickers.some((x) => x.ticker === t)) tickers.push({ ticker: t, firstUse: null });
  }

  const equities: Record<string, number> = {};
  const dividends: Record<string, number> = {};
  for (const { ticker, firstUse } of tickers) {
    const last = ticker.endsWith("-USD") ? cryptoCompletedUtcYmd(now) : yesterday;
    const withDividends = benchmarkTickers.has(ticker);
    const { series, divs } = await withDemoMarketRetries(`Yahoo ${ticker}`, async () => {
      let raw: EodCloseSeries;
      let divs: { ex_date: string; amount: number }[] = [];
      if (withDividends) {
        const r = await fetchYahooDailyClosesAndDividends(ticker, unixSeconds(from), p2);
        raw = r.series;
        divs = r.dividends.filter((d) => d.ex_date <= last);
        if (divs.length === 0) throw new Error(`no dividends for benchmark ticker ${ticker}`);
      } else {
        raw = await fetchYahooDailyCloses(ticker, unixSeconds(from), p2);
      }
      const s = closesThrough(raw, last);
      if (s.dates.length === 0) throw new Error(`no closes for ${ticker}`);
      return { series: s, divs };
    });
    if (firstUse != null && series.dates[0]! > firstUse) {
      throw new Error(`demo market: ${ticker} history starts ${series.dates[0]}, after its first use ${firstUse}`);
    }
    equities[ticker] = upsertEquityDailySeries(ticker, series);
    if (withDividends) dividends[ticker] = insertEquityDividendsIfMissing(ticker, divs).inserted;
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

  const pension = spec.withAfp ? await loadDemoPensionMarket(cl.ymd) : null;

  return {
    from,
    through: yesterday,
    equities,
    dividends,
    fx,
    bcentral: { usd: usd.length, eur: eur.length, uf: uf.length, utm: utm.length, ipc: ipc.length },
    afp_official: pension ? pension.modelo + pension.uno : 0,
  };
}
