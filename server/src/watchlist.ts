import { listDistinctEquityTickersForSync } from "./accountEquityTicker.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { db } from "./db.js";
import { ensureEquityDailyHistoryForWatchlistTickers } from "./equityDailyWatchlistBackfill.js";
import { equityMarketKind } from "./equityQuote.js";
import { notifyGlobalSyncScheduler } from "./globalSyncScheduler.js";
import {
  compositeHoldingsWithStats,
  type WatchlistCompositeHoldingRow,
} from "./watchlistCompositeHoldings.js";
import type { MarketDisplaySeriesRow, WatchlistSource } from "./marketDisplaySeries.js";
import { watchlistStatsForRow, type WatchlistRowStats } from "./watchlistStats.js";
import { listCompositeConstituentTickers, RISKY_NORRIS_PROXY_BUCKET } from "./watchlistComposite.js";

export type { WatchlistSource } from "./marketDisplaySeries.js";
export type { WatchlistCompositeHoldingRow } from "./watchlistCompositeHoldings.js";

export type WatchlistRow = MarketDisplaySeriesRow &
  WatchlistRowStats & {
    composite_holdings?: WatchlistCompositeHoldingRow[];
  };

const BUILTIN_INSTRUMENTS: {
  slug: string;
  label: string;
  label_i18n_key: string | null;
  sort_order: number;
  kind: MarketDisplaySeriesRow["kind"];
  series_key: string | null;
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
  },
  {
    slug: "fintual_risky_norris",
    label: "Risky Norris",
    label_i18n_key: null,
    sort_order: 40,
    kind: "fund_unit",
    series_key: "fintual_risky_norris",
  },
  {
    slug: "fintual_risky_norris_proxy",
    label: "Risky Norris (proxy)",
    label_i18n_key: "watchlist.riskyNorrisProxy",
    sort_order: 45,
    kind: "composite",
    series_key: RISKY_NORRIS_PROXY_BUCKET,
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

export function listWatchlistNyseTickersForEodSync(): string[] {
  syncWatchlistFromApp();
  return listWatchlistEquitySeriesKeys().filter((t) => equityMarketKind(t) === "nyse");
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
}

/** Idempotent sync of builtin + account instruments into market_display_series. */
export function syncWatchlistFromApp(): void {
  db.transaction(() => {
    consolidateAfpUnoDisplaySeries();

    for (const b of BUILTIN_INSTRUMENTS) {
      const existing = db
        .prepare(`SELECT id FROM market_display_series WHERE slug = ?`)
        .get(b.slug) as { id: number } | undefined;
      if (existing == null) {
        stmtInsert.run(
          b.slug,
          b.label,
          b.label_i18n_key,
          b.sort_order,
          b.kind,
          b.series_key,
          1,
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
        0,
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
  })();
}

function rowToWatchlist(row: MarketDisplaySeriesRow & { source: WatchlistSource }, now: Date): WatchlistRow {
  const stats = watchlistStatsForRow(row, now);
  const item: WatchlistRow = { ...row, ...stats };
  if (row.kind === "composite" && row.series_key) {
    const holdings = compositeHoldingsWithStats(row.series_key, now);
    if (holdings.length > 0) item.composite_holdings = holdings;
  }
  return item;
}

export async function getWatchlistPayload(now = new Date()): Promise<{ app: WatchlistRow[]; manual: WatchlistRow[] }> {
  syncWatchlistFromApp();
  const today = chileCalendarTodayYmd();
  const rows = stmtSelectAll.all() as (MarketDisplaySeriesRow & { source: WatchlistSource })[];
  const equityTickers = rows
    .filter((r) => r.kind === "equity" && r.series_key?.trim())
    .map((r) => r.series_key!.trim().toUpperCase());
  const compositionTickers = listCompositeConstituentTickers();
  await ensureEquityDailyHistoryForWatchlistTickers(
    [...new Set([...equityTickers, ...compositionTickers])],
    today
  );

  const app: WatchlistRow[] = [];
  const manual: WatchlistRow[] = [];
  for (const row of rows) {
    const item = rowToWatchlist(row, now);
    if (row.source === "manual") manual.push(item);
    else app.push(item);
  }
  return { app, manual };
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

const TICKER_RE = /^[A-Z0-9][A-Z0-9.-]{0,19}$/;

export function normalizeManualWatchlistTicker(raw: string): string {
  const ticker = raw.trim().toUpperCase();
  if (!ticker || !TICKER_RE.test(ticker)) {
    throw new Error("invalid ticker symbol");
  }
  return ticker;
}

export function addManualWatchlistTicker(tickerRaw: string): WatchlistRow {
  const ticker = normalizeManualWatchlistTicker(tickerRaw);
  const existing = stmtEquityBySeriesKey.get(ticker) as { id: number } | undefined;
  if (existing != null) {
    throw new Error(`ticker ${ticker} is already on the watchlist`);
  }
  const slug = equitySlug(ticker);
  const slugTaken = db.prepare(`SELECT 1 FROM market_display_series WHERE slug = ?`).get(slug);
  if (slugTaken) {
    throw new Error(`ticker ${ticker} is already on the watchlist`);
  }
  const maxSort =
    (db
      .prepare(
        `SELECT COALESCE(MAX(sort_order), 0) AS m FROM market_display_series WHERE source = 'manual'`
      )
      .get() as { m: number }).m ?? 0;
  stmtInsert.run(
    slug,
    ticker,
    null,
    maxSort + 10,
    "equity",
    ticker,
    1,
    ticker,
    "manual"
  );
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
