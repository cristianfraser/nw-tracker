import { listDistinctEquityTickersForSync } from "./accountEquityTicker.js";
import { invalidateMarketDataAggregations } from "./aggregationCache.js";
import { listBenchmarkEquityTickers } from "./benchmarkLevels.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { db } from "./db.js";
import { ensureEquityDailyHistoryForWatchlistTickers } from "./equityDailyWatchlistBackfill.js";
import { equityMarketKind } from "./equityQuote.js";
import {
  latestMarketSymbolFetchError,
  registerMarketSymbol,
  reloadMarketSymbols,
  type MarketSymbolFetchError,
  type MarketSymbolRow,
} from "./marketSymbols.js";
import { notifyGlobalSyncScheduler } from "./globalSyncScheduler.js";
import {
  compositeHoldingsWithStats,
  type WatchlistCompositeHoldingRow,
} from "./watchlistCompositeHoldings.js";
import type { MarketDisplaySeriesRow, WatchlistSource } from "./marketDisplaySeries.js";
import {
  watchlistStatsForRow,
  type WatchlistDisplayUnit,
  type WatchlistRowStats,
} from "./watchlistStats.js";
import { searchYahooSymbols, verifyYahooSymbol, type YahooSymbolSearchResult } from "./yahooSymbols.js";
import {
  listCompositeConstituentTickers,
  loadCompositeHoldings,
  loadCompositeMeta,
  RISKY_NORRIS_PROXY_BUCKET,
} from "./watchlistComposite.js";

export type { WatchlistSource } from "./marketDisplaySeries.js";
export type { WatchlistCompositeHoldingRow } from "./watchlistCompositeHoldings.js";
export type { WatchlistDisplayUnit } from "./watchlistStats.js";
export { watchlistDisplayUnitParam } from "./watchlistStats.js";

export type WatchlistRow = MarketDisplaySeriesRow &
  WatchlistRowStats & {
    composite_holdings?: WatchlistCompositeHoldingRow[];
    /** An equity row's latest Yahoo fetch failure (live quote or history), null once a fetch succeeds. */
    fetch_error: MarketSymbolFetchError | null;
  };

const stmtFundUnitHasData = db.prepare(
  `SELECT 1 FROM fund_unit_daily WHERE series_key = ? LIMIT 1`
);

/** A fund/composite builtin whose backing data is absent (e.g. the demo DB) is never inserted. */
function fundSeriesHasData(seriesKey: string): boolean {
  return stmtFundUnitHasData.get(seriesKey) != null;
}

function riskyNorrisProxyHasData(): boolean {
  return (
    loadCompositeMeta(RISKY_NORRIS_PROXY_BUCKET) != null &&
    loadCompositeHoldings(RISKY_NORRIS_PROXY_BUCKET).length > 0
  );
}

const BUILTIN_INSTRUMENTS: {
  slug: string;
  label: string;
  label_i18n_key: string | null;
  sort_order: number;
  kind: MarketDisplaySeriesRow["kind"];
  series_key: string | null;
  /** Insert only when the instrument's backing data exists; omitted = always insert (UF/USD). */
  hasBackingData?: () => boolean;
  /** Marquee chip on first insert (default on); the rates page reads `show_in_rates` instead. */
  show_in_marquee?: 0 | 1;
}[] = [
  {
    slug: "uf",
    label: "UF",
    label_i18n_key: "marketTicker.uf",
    sort_order: 10,
    kind: "uf",
    series_key: null,
  },
  {
    slug: "usd",
    label: "USD",
    label_i18n_key: "marketTicker.usdLive",
    sort_order: 20,
    kind: "fx_usd",
    series_key: null,
  },
  {
    slug: "afp_uno_cuota_a",
    label: "UNO-A",
    label_i18n_key: null,
    sort_order: 30,
    kind: "fund_unit",
    series_key: "afp_uno_cuota_a",
    hasBackingData: () => fundSeriesHasData("afp_uno_cuota_a"),
  },
  {
    // AFC Fondo de Cesantía (CIC) valor cuota — rates page only: the marquee client renders a
    // fixed set of fund chips, and a second cuota series there adds noise, not information.
    slug: "afc_cic",
    label: "AFC CIC",
    label_i18n_key: null,
    sort_order: 35,
    kind: "fund_unit",
    series_key: "afc_cic",
    hasBackingData: () => fundSeriesHasData("afc_cic"),
    show_in_marquee: 0,
  },
  {
    slug: "fintual_risky_norris",
    label: "Risky Norris",
    label_i18n_key: null,
    sort_order: 40,
    kind: "fund_unit",
    series_key: "fintual_risky_norris",
    hasBackingData: () => fundSeriesHasData("fintual_risky_norris"),
  },
  {
    slug: "fintual_risky_norris_proxy",
    label: "Risky Norris (proxy)",
    label_i18n_key: "watchlist.riskyNorrisProxy",
    sort_order: 45,
    kind: "composite",
    series_key: RISKY_NORRIS_PROXY_BUCKET,
    hasBackingData: riskyNorrisProxyHasData,
  },
];

const stmtSelectAll = db.prepare(
  `SELECT id, slug, label, label_i18n_key, sort_order, kind, series_key,
          show_in_marquee, show_in_rates, rates_chart_title, source
   FROM market_display_series
   ORDER BY sort_order, id`
);

const stmtSelectById = db.prepare(
  `SELECT id, slug, label, label_i18n_key, sort_order, kind, series_key,
          show_in_marquee, show_in_rates, rates_chart_title, source
   FROM market_display_series WHERE id = ?`
);

const stmtEquityBySeriesKey = db.prepare(
  `SELECT id FROM market_display_series
   WHERE kind = 'equity' AND upper(series_key) = upper(?) LIMIT 1`
);

const stmtInsert = db.prepare(
  `INSERT INTO market_display_series (
     slug, label, label_i18n_key, sort_order, kind, series_key,
     show_in_marquee, show_in_rates, rates_chart_title, source
   ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
);

const stmtUpdateMarquee = db.prepare(
  `UPDATE market_display_series SET show_in_marquee = ? WHERE id = ?`
);

const stmtUpdateSortOrder = db.prepare(
  `UPDATE market_display_series SET sort_order = ? WHERE id = ?`
);

const stmtDeleteById = db.prepare(`DELETE FROM market_display_series WHERE id = ?`);

function equitySlug(ticker: string): string {
  return `eq_${ticker.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
}

function accountTickerSortOrder(ticker: string): number {
  return 100 + ticker.charCodeAt(0);
}

export function listWatchlistEquitySeriesKeys(): string[] {
  const rows = stmtSelectAll.all() as { kind: string; series_key: string | null }[];
  const fromRows = [
    ...new Set(
      rows
        .filter((r) => r.kind === "equity" && r.series_key?.trim())
        .map((r) => r.series_key!.trim().toUpperCase())
    ),
  ];
  const compositeTickers = listCompositeConstituentTickers(RISKY_NORRIS_PROXY_BUCKET);
  return [...new Set([...fromRows, ...compositeTickers])];
}

/** NYSE-only tickers — drives the stocks_nyse caught-up/stale state (`.SN` has its own source). */
export function listWatchlistNyseTickersForEodSync(): string[] {
  syncWatchlistFromApp();
  // Benchmark tickers (the Rentabilidad comparison) need their closes and dividends kept current
  // whether or not anything holds or watches them.
  const tickers = new Set([...listWatchlistEquitySeriesKeys(), ...listBenchmarkEquityTickers()]);
  return [...tickers].filter((t) => equityMarketKind(t) === "nyse");
}

/** Bolsa de Santiago tickers — drives the stocks_santiago caught-up/stale state (Chile calendar). */
export function listWatchlistSantiagoTickersForEodSync(): string[] {
  syncWatchlistFromApp();
  return listWatchlistEquitySeriesKeys().filter((t) => equityMarketKind(t) === "santiago");
}

export function listWatchlistCryptoTickersForEodSync(): string[] {
  syncWatchlistFromApp();
  return listWatchlistEquitySeriesKeys().filter((t) => equityMarketKind(t) === "crypto24");
}

/** Drop legacy rates-only AFP UNO row; UNO-A carries marquee + rates. */
function consolidateAfpUnoDisplaySeries(): void {
  db.prepare(`DELETE FROM market_display_series WHERE slug = 'afp_uno_rates'`).run();
  db.prepare(
    `UPDATE market_display_series
     SET show_in_rates = 1, rates_chart_title = 'UNO-A'
     WHERE slug = 'afp_uno_cuota_a'`
  ).run();
  db.prepare(
    `UPDATE market_display_series
     SET show_in_rates = 1, rates_chart_title = 'AFC CIC'
     WHERE slug = 'afc_cic'`
  ).run();
}

/** Idempotent sync of builtin + account instruments into market_display_series. */
export function syncWatchlistFromApp(): void {
  db.transaction(() => {
    for (const b of BUILTIN_INSTRUMENTS) {
      const existing = db
        .prepare(`SELECT id FROM market_display_series WHERE slug = ?`)
        .get(b.slug) as { id: number } | undefined;
      if (existing == null && (b.hasBackingData?.() ?? true)) {
        stmtInsert.run(
          b.slug,
          b.label,
          b.label_i18n_key,
          b.sort_order,
          b.kind,
          b.series_key,
          b.show_in_marquee ?? 1,
          b.kind === "equity" ? b.label : null,
          "builtin"
        );
      }
    }

    const accountTickers = listDistinctEquityTickersForSync();
    for (const ticker of accountTickers) {
      const existing = stmtEquityBySeriesKey.get(ticker) as { id: number } | undefined;
      if (existing != null) continue;
      stmtInsert.run(
        equitySlug(ticker),
        ticker,
        null,
        accountTickerSortOrder(ticker),
        "equity",
        ticker,
        1,
        ticker,
        "account"
      );
    }

    if (accountTickers.length === 0) {
      db.prepare(
        `DELETE FROM market_display_series WHERE source = 'account' AND kind = 'equity'`
      ).run();
    } else {
      const placeholders = accountTickers.map(() => "upper(?)").join(", ");
      db.prepare(
        `DELETE FROM market_display_series
         WHERE source = 'account' AND kind = 'equity'
           AND upper(series_key) NOT IN (${placeholders})`
      ).run(...accountTickers);
    }

    // After the UNO-A builtin may have just been inserted, stamp its rates flag / title in the same sync.
    consolidateAfpUnoDisplaySeries();
  })();
}

function rowToWatchlist(
  row: MarketDisplaySeriesRow & { source: WatchlistSource },
  now: Date,
  unit: WatchlistDisplayUnit = "clp"
): WatchlistRow {
  const stats = watchlistStatsForRow(row, now, unit);
  const fetch_error =
    row.kind === "equity" && row.series_key?.trim() ? latestMarketSymbolFetchError(row.series_key.trim()) : null;
  const item: WatchlistRow = { ...row, ...stats, fetch_error };
  if (row.kind === "composite" && row.series_key) {
    const holdings = compositeHoldingsWithStats(row.series_key, now, unit);
    if (holdings.length > 0) item.composite_holdings = holdings;
  }
  return item;
}

/**
 * DB-only payload — never fetches Yahoo. History depth for the YTD/YoY stats is maintained
 * by {@link ensureWatchlistEquityHistoryDepth} on the live-quotes scheduler tick.
 * Values and changes come back in `unit` (the app's CLP/USD toggle) — see
 * {@link watchlistStatsForRow}; the USD/CLP rate row is the one exception.
 */
export function getWatchlistPayload(
  now = new Date(),
  unit: WatchlistDisplayUnit = "clp"
): { unit: WatchlistDisplayUnit; app: WatchlistRow[]; manual: WatchlistRow[] } {
  syncWatchlistFromApp();
  reloadMarketSymbols();
  const rows = stmtSelectAll.all() as (MarketDisplaySeriesRow & { source: WatchlistSource })[];
  const app: WatchlistRow[] = [];
  const manual: WatchlistRow[] = [];
  for (const row of rows) {
    const item = rowToWatchlist(row, now, unit);
    if (row.source === "manual") manual.push(item);
    else app.push(item);
  }
  return { unit, app, manual };
}

/**
 * Ensure `equity_daily` reaches the watchlist YTD/YoY anchors for every watchlist equity
 * ticker + composite constituent (~400d Yahoo backfill for new/shallow tickers). Runs on the
 * live-quotes scheduler tick and the manual `live-quotes:sync` script — never on HTTP request
 * paths. Invalidates market-data aggregations when history rows were actually added.
 */
export async function ensureWatchlistEquityHistoryDepth(): Promise<number> {
  syncWatchlistFromApp();
  const backfilled = await ensureEquityDailyHistoryForWatchlistTickers(
    listWatchlistEquitySeriesKeys(),
    chileCalendarTodayYmd()
  );
  if (backfilled > 0) invalidateMarketDataAggregations();
  return backfilled;
}

export function patchWatchlistRow(
  id: number,
  patch: { show_in_marquee?: number; sort_order?: number }
): WatchlistRow {
  const existing = stmtSelectById.get(id) as
    | (MarketDisplaySeriesRow & { source: WatchlistSource })
    | undefined;
  if (existing == null) {
    throw new Error(`watchlist row ${id} not found`);
  }
  if (patch.show_in_marquee != null) {
    if (patch.show_in_marquee !== 0 && patch.show_in_marquee !== 1) {
      throw new Error("show_in_marquee must be 0 or 1");
    }
    stmtUpdateMarquee.run(patch.show_in_marquee, id);
  }
  if (patch.sort_order != null) {
    if (!Number.isFinite(patch.sort_order)) {
      throw new Error("sort_order must be a finite number");
    }
    stmtUpdateSortOrder.run(patch.sort_order, id);
  }
  const updated = stmtSelectById.get(id) as MarketDisplaySeriesRow & { source: WatchlistSource };
  return rowToWatchlist(updated, new Date());
}

/** Yahoo's own symbol shapes: letters, digits, `.` / `-` (`DX-Y.NYB`), `=` (`GC=F`), a leading `^` for indices. */
const TICKER_RE = /^\^?[A-Z0-9][A-Z0-9.=-]{0,19}$/;

export function normalizeManualWatchlistTicker(raw: string): string {
  const ticker = raw.trim().toUpperCase();
  if (!ticker || !TICKER_RE.test(ticker)) {
    throw new Error("invalid ticker symbol");
  }
  return ticker;
}

function assertNotOnWatchlist(ticker: string): void {
  const existing = stmtEquityBySeriesKey.get(ticker) as { id: number } | undefined;
  const slugTaken = db.prepare(`SELECT 1 FROM market_display_series WHERE slug = ?`).get(equitySlug(ticker));
  if (existing != null || slugTaken) {
    throw new Error(`ticker ${ticker} is already on the watchlist`);
  }
}

/**
 * Adds a symbol Yahoo has already been asked about ({@link verifyYahooSymbol}): its quote
 * currency and market are recorded in `market_symbols`, so the sync stores its prices and the
 * watchlist reads them on the right calendar and in the right currency (or none, for an index).
 */
export function addManualWatchlistTicker(symbol: MarketSymbolRow): WatchlistRow {
  const ticker = normalizeManualWatchlistTicker(symbol.ticker);
  const slug = equitySlug(ticker);
  db.transaction(() => {
    assertNotOnWatchlist(ticker);
    const maxSort =
      (db
        .prepare(
          `SELECT COALESCE(MAX(sort_order), 0) AS m FROM market_display_series WHERE source = 'manual'`
        )
        .get() as { m: number }).m ?? 0;
    registerMarketSymbol({ ...symbol, ticker });
    stmtInsert.run(slug, ticker, null, maxSort + 10, "equity", ticker, 1, ticker, "manual");
  })();
  // Missing EOD for new tickers surfaces as natural stocks_nyse / crypto_eod stale — no userForcedStale pin.
  notifyGlobalSyncScheduler();
  const row = db
    .prepare(
      `SELECT id, slug, label, label_i18n_key, sort_order, kind, series_key,
              show_in_marquee, show_in_rates, rates_chart_title, source
       FROM market_display_series WHERE slug = ?`
    )
    .get(slug) as MarketDisplaySeriesRow & { source: WatchlistSource };
  return rowToWatchlist(row, new Date());
}

/** The add box's path: refuse a symbol already listed before asking Yahoo, then add what Yahoo confirms. */
export async function addManualWatchlistTickerFromYahoo(
  raw: string,
  verify: (ticker: string) => Promise<MarketSymbolRow> = verifyYahooSymbol
): Promise<WatchlistRow> {
  const ticker = normalizeManualWatchlistTicker(raw);
  assertNotOnWatchlist(ticker);
  return addManualWatchlistTicker(await verify(ticker));
}

export type WatchlistSymbolSearchResult = YahooSymbolSearchResult & { on_watchlist: boolean };

/** Yahoo's matches for what the user typed, each marked when it is already on the watchlist. */
export async function searchWatchlistSymbols(
  query: string,
  search: (q: string) => Promise<YahooSymbolSearchResult[]> = searchYahooSymbols
): Promise<WatchlistSymbolSearchResult[]> {
  const results = await search(query);
  return results.map((r) => ({
    ...r,
    on_watchlist: stmtEquityBySeriesKey.get(r.symbol) != null,
  }));
}

export function deleteManualWatchlistRow(id: number): void {
  const existing = stmtSelectById.get(id) as { source: WatchlistSource } | undefined;
  if (existing == null) {
    throw new Error(`watchlist row ${id} not found`);
  }
  if (existing.source !== "manual") {
    throw new Error("only manual watchlist rows can be deleted");
  }
  stmtDeleteById.run(id);
}
