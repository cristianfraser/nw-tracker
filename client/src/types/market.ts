import type { FxCoverage } from "./core";

/** `GET /api/market-series` — sparse observations per field (no cross-series forward-fill); CLP crosses use FX on or before each equity/fund observation date. */
export interface MarketSeriesPoint {
  as_of_date: string;
  clp_per_usd: number | null;
  clp_per_uf: number | null;
  clp_per_eur: number | null;
  ipc_index: number | null;
  equity_usd: Record<string, number | null>;
  equity_clp: Record<string, number | null>;
  fund_unit_clp: Record<string, number | null>;
  fund_unit_usd: Record<string, number | null>;
}

export interface MarketSeriesResponse {
  points: MarketSeriesPoint[];
  equity_tickers: string[];
  fund_series_keys: string[];
  fx_usd_clp: { date: string; value: number }[];
  fx_usd_clp_bcentral: { date: string; value: number }[];
  fx_usd_clp_buy?: { date: string; value: number }[];
  fx_usd_clp_sell?: { date: string; value: number }[];
  eur_clp: { date: string; value: number }[];
  fx_coverage: FxCoverage;
}

/** `GET /api/market-ticker` — Chile-today snapshot for the marquee (not forward-filled series tail). */
export interface MarketDisplaySeriesRow {
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
  source: "builtin" | "account" | "manual";
}

export interface WatchlistChanges {
  day_pct: number | null;
  week_pct: number | null;
  mtd_pct: number | null;
  mom_pct: number | null;
  ytd_pct: number | null;
  yoy_pct: number | null;
  y3_pct: number | null;
  y5_pct: number | null;
  y10_pct: number | null;
}

export interface WatchlistCompositeHoldingRow {
  ticker: string;
  weight: number;
  value: number | null;
  /** Currency `value` is expressed in — the requested display unit (the fx rate row is always CLP per USD). */
  value_currency: "usd" | "clp";
  as_of_date: string | null;
  changes: WatchlistChanges | null;
}

export interface WatchlistRow extends MarketDisplaySeriesRow {
  value: number | null;
  /** Currency `value` is expressed in — the requested display unit (the fx rate row is always CLP per USD). */
  value_currency: "usd" | "clp";
  as_of_date: string | null;
  changes: WatchlistChanges | null;
  composite_holdings?: WatchlistCompositeHoldingRow[];
}

/** `GET /api/watchlist?unit=` — every value and change column expressed in `unit`. */
export interface WatchlistResponse {
  unit: "clp" | "usd";
  app: WatchlistRow[];
  manual: WatchlistRow[];
}

/** One marquee chip: the series' latest value in the payload's `unit` and its day change. */
export interface MarketTickerValue {
  day: string;
  value: number;
  currency: "usd" | "clp";
  delta_pct: number | null;
}

/** `GET /api/market-ticker?unit=` — the same row stats as the watchlist, in the display unit. */
export interface MarketTickerResponse {
  chile_today: string;
  unit: "clp" | "usd";
  uf: MarketTickerValue | null;
  /** The USD/CLP rate itself — CLP per USD in both units. */
  usd: { date: string; clp_per_usd: number; delta_pct: number | null } | null;
  uno_a: MarketTickerValue | null;
  risky_norris: MarketTickerValue | null;
  risky_norris_proxy: MarketTickerValue | null;
  equities: {
    ticker: string;
    trade_date: string;
    value: number;
    /** Currency `value` is expressed in — the payload's `unit`. */
    currency: "usd" | "clp";
    delta_pct: number | null;
  }[];
  marquee_series?: MarketDisplaySeriesRow[];
}

export interface RatesInstrumentsResponse {
  instruments: MarketDisplaySeriesRow[];
}
