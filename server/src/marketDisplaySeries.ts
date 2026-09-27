import { AFP_UNO_CUOTA_SERIES_KEY } from "./afpQuetalmiApi.js";
import { chileWallClockAt } from "./chileDate.js";
import { db } from "./db.js";
import { syncWatchlistFromApp } from "./watchlist.js";
import { RISKY_NORRIS_PROXY_BUCKET } from "./watchlistComposite.js";
import {
  watchlistStatsForRow,
  type WatchlistDisplayUnit,
  type WatchlistRowStats,
} from "./watchlistStats.js";

export type WatchlistSource = "builtin" | "account" | "manual";

export type MarketDisplaySeriesRow = {
  id: number;
  slug: string;
  label: string;
  label_i18n_key: string | null;
  sort_order: number;
  kind: "equity" | "fund_unit" | "fx_usd" | "uf" | "composite";
  series_key: string | null;
  show_in_marquee: number;
  show_in_rates: number;
  rates_chart_title: string | null;
  source: WatchlistSource;
};

const stmtAll = db.prepare(
  `SELECT id, slug, label, label_i18n_key, sort_order, kind, series_key,
          show_in_marquee, show_in_rates, rates_chart_title, source
   FROM market_display_series
   ORDER BY sort_order, id`
);

export function listMarqueeSeries(): MarketDisplaySeriesRow[] {
  return (stmtAll.all() as MarketDisplaySeriesRow[]).filter((r) => r.show_in_marquee === 1);
}

export function listRatesInstrumentSeries(): MarketDisplaySeriesRow[] {
  return (stmtAll.all() as MarketDisplaySeriesRow[]).filter((r) => r.show_in_rates === 1);
}

/** One marquee chip: the series' latest value in the payload's display unit and its day change. */
export type MarketTickerValue = {
  day: string;
  value: number;
  /** Currency `value` is expressed in — the payload's `unit`. */
  currency: "usd" | "clp";
  delta_pct: number | null;
};

export type MarketTickerEquityRow = {
  ticker: string;
  trade_date: string;
  value: number;
  /** Currency `value` is expressed in — the payload's `unit` (a `.SN` ticker is converted too). */
  currency: "usd" | "clp";
  delta_pct: number | null;
};

/** Yahoo live/EOD symbols for marquee rows with show_in_marquee = 1. */
export function equityTickersForMarqueeQuotes(marqueeSeries: MarketDisplaySeriesRow[]): string[] {
  return [
    ...new Set(
      marqueeSeries
        .filter((r) => r.kind === "equity" && r.show_in_marquee === 1 && r.series_key?.trim())
        .map((r) => r.series_key!.trim().toUpperCase())
    ),
  ];
}

export type MarketTickerPayload = {
  chile_today: string;
  /** Display unit every value below is expressed in (the app's CLP/USD toggle), except `usd`. */
  unit: WatchlistDisplayUnit;
  uf: MarketTickerValue | null;
  /** The USD/CLP rate itself — CLP per USD in both units. */
  usd: { date: string; clp_per_usd: number; delta_pct: number | null } | null;
  uno_a: MarketTickerValue | null;
  risky_norris: MarketTickerValue | null;
  risky_norris_proxy: MarketTickerValue | null;
  equities: MarketTickerEquityRow[];
  /** Series config used to build this payload (marquee labels / order). */
  marquee_series: MarketDisplaySeriesRow[];
};

function tickerValue(stats: WatchlistRowStats): MarketTickerValue | null {
  if (stats.value == null || stats.as_of_date == null) return null;
  return {
    day: stats.as_of_date,
    value: stats.value,
    currency: stats.value_currency,
    delta_pct: stats.changes?.day_pct ?? null,
  };
}

/**
 * Marquee snapshot driven by `market_display_series` rows with `show_in_marquee = 1`.
 *
 * Every chip is the watchlist's own row stats (`watchlistStatsForRow`) in the requested unit,
 * so the strip and the watchlist page cannot disagree: values convert leg by leg into `unit`
 * and day deltas are display values (`displayDayPct`) — the real last-vs-prior change on days
 * the instrument's market is open, a hard 0 on its closed days.
 */
export function getMarketTickerPayloadFromDb(
  now = new Date(),
  unit: WatchlistDisplayUnit = "clp"
): MarketTickerPayload {
  syncWatchlistFromApp();
  const today = chileWallClockAt(now).ymd;
  const marquee_series = listMarqueeSeries();

  let uf: MarketTickerPayload["uf"] = null;
  let usd: MarketTickerPayload["usd"] = null;
  let uno_a: MarketTickerPayload["uno_a"] = null;
  let risky_norris: MarketTickerPayload["risky_norris"] = null;
  let risky_norris_proxy: MarketTickerPayload["risky_norris_proxy"] = null;
  const equities: MarketTickerEquityRow[] = [];

  for (const row of marquee_series) {
    if (row.kind === "uf") {
      uf = tickerValue(watchlistStatsForRow(row, now, unit));
      continue;
    }
    if (row.kind === "fx_usd") {
      const stats = watchlistStatsForRow(row, now, unit);
      if (stats.value != null && stats.as_of_date != null) {
        usd = {
          date: stats.as_of_date,
          clp_per_usd: stats.value,
          delta_pct: stats.changes?.day_pct ?? null,
        };
      }
      continue;
    }
    if (row.kind === "fund_unit" && row.series_key) {
      if (row.series_key === AFP_UNO_CUOTA_SERIES_KEY || row.slug === "afp_uno_cuota_a") {
        uno_a = tickerValue(watchlistStatsForRow(row, now, unit));
        continue;
      }
      if (
        row.series_key === "fintual_risky_norris" ||
        row.series_key === "fintual_cert_risky_norris"
      ) {
        risky_norris = tickerValue(watchlistStatsForRow(row, now, unit));
        continue;
      }
    }
    if (row.kind === "composite" && row.series_key === RISKY_NORRIS_PROXY_BUCKET) {
      risky_norris_proxy = tickerValue(watchlistStatsForRow(row, now, unit));
      continue;
    }
  }

  for (const ticker of equityTickersForMarqueeQuotes(marquee_series)) {
    const row = marquee_series.find(
      (r) => r.kind === "equity" && r.series_key?.trim().toUpperCase() === ticker
    );
    if (row == null) continue;
    const stats = watchlistStatsForRow(row, now, unit);
    if (stats.value == null || stats.as_of_date == null) continue;
    equities.push({
      ticker,
      trade_date: stats.as_of_date,
      value: stats.value,
      currency: stats.value_currency,
      delta_pct: stats.changes?.day_pct ?? null,
    });
  }

  return {
    chile_today: today,
    unit,
    uf,
    usd,
    uno_a,
    risky_norris,
    risky_norris_proxy,
    equities,
    marquee_series,
  };
}
