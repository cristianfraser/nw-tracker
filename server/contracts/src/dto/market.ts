import type { FxCoverage, DisplayUnitCode } from "./core.js";

/**
 * `GET /api/market-series?unit=` — sparse observations per field (no cross-series forward-fill).
 * The rate fields are facts in their own quote; `equity` / `fund_unit` are in the response's
 * `unit`, converted at the stored rate on or before each observation date.
 */
export interface MarketSeriesPoint {
  as_of_date: string;
  clp_per_usd: number | null; // convention-ok: a rate series' own quote (pesos per dollar / euro, UTM in pesos)
  clp_per_uf: number | null;
  clp_per_eur: number | null; // convention-ok: a rate series' own quote (pesos per dollar / euro, UTM in pesos)
  ipc_index: number | null;
  utm_clp: number | null; // convention-ok: a rate series' own quote (pesos per dollar / euro, UTM in pesos)
  /** Each equity's close on the day in `unit`. */
  equity: Record<string, number | null>;
  /** Each peso fund series' valor cuota on the day in `unit`. */
  fund_unit: Record<string, number | null>;
}

export interface MarketSeriesResponse {
  unit: DisplayUnitCode;
  points: MarketSeriesPoint[];
  equity_tickers: string[];
  fund_series_keys: string[];
  fx_usd_clp: { date: string; value: number }[]; // convention-ok: a rate series' own quote (pesos per dollar / euro, UTM in pesos)
  fx_usd_clp_bcentral: { date: string; value: number }[];
  fx_usd_clp_buy?: { date: string; value: number }[];
  fx_usd_clp_sell?: { date: string; value: number }[];
  eur_clp: { date: string; value: number }[]; // convention-ok: a rate series' own quote (pesos per dollar / euro, UTM in pesos)
  /** EUR/USD (`fx_rates`, Yahoo EURUSD=X): dollars per euro. */
  eur_usd: { date: string; value: number }[]; // convention-ok: a rate pair's own series, not a display amount
  fx_coverage: FxCoverage;
}

/** `GET /api/market-ticker` — Chile-today snapshot for the marquee (not forward-filled series tail). */
export interface MarketDisplaySeriesRow {
  id: number;
  slug: string;
  label: string;
  label_i18n_key: string | null;
  sort_order: number;
  /**
   * `fx_usd`: the USD/CLP rate (live CLP=X). `fx_pair`: another pair's rate, `series_key`
   * `<base>_<quote>` (`eur_usd`, `eur_clp`). Both are rates, never converted.
   */
  kind: "equity" | "fund_unit" | "fx_usd" | "fx_pair" | "uf" | "composite";
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
  value_currency: DisplayUnitCode | "none";
  as_of_date: string | null;
  changes: WatchlistChanges | null;
}

export interface WatchlistRow extends MarketDisplaySeriesRow {
  value: number | null;
  /**
   * Currency `value` is expressed in — the requested display unit, except the fx rate row
   * (always CLP per USD) and an index (`none`: points in every unit).
   */
  value_currency: DisplayUnitCode | "none";
  as_of_date: string | null;
  changes: WatchlistChanges | null;
  composite_holdings?: WatchlistCompositeHoldingRow[];
  /** An equity row's latest Yahoo fetch failure; null once a fetch succeeds. */
  fetch_error: { stage: "live" | "history"; message: string; failed_at: string } | null;
}

/** `GET /api/watchlist/search?q=` — Yahoo's matches for what was typed in the add box. */
export interface WatchlistSymbolSearchResult {
  symbol: string;
  name: string | null;
  exchange: string | null;
  type: string | null;
  on_watchlist: boolean;
}

/** `GET /api/watchlist?unit=` — every value and change column expressed in `unit`. */
export interface WatchlistResponse {
  unit: DisplayUnitCode;
  app: WatchlistRow[];
  manual: WatchlistRow[];
}

/** One marquee chip: the series' latest value in the payload's `unit` and its day change. */
export interface MarketTickerValue {
  day: string;
  value: number;
  currency: DisplayUnitCode | "none";
  delta_pct: number | null;
}

/** `GET /api/market-ticker?unit=` — the same row stats as the watchlist, in the display unit. */
export interface MarketTickerResponse {
  chile_today: string;
  unit: DisplayUnitCode;
  uf: MarketTickerValue | null;
  /** The USD/CLP rate itself — CLP per USD in every unit. */
  usd: { date: string; clp_per_usd: number; delta_pct: number | null } | null; // convention-ok: a rate series' own quote (pesos per dollar / euro, UTM in pesos)
  /** Every other rate pair on the marquee (EUR/USD, EUR/CLP): quote units per one base unit. */
  fx_pairs: {
    /** The row's `series_key` (`eur_usd`). */
    pair: string;
    base: string;
    quote: string;
    date: string;
    rate: number;
    delta_pct: number | null;
  }[];
  uno_a: MarketTickerValue | null;
  risky_norris: MarketTickerValue | null;
  risky_norris_proxy: MarketTickerValue | null;
  equities: {
    ticker: string;
    trade_date: string;
    value: number;
    /** Currency `value` is expressed in — the payload's `unit`; `none` for an index (points). */
    currency: DisplayUnitCode | "none";
    delta_pct: number | null;
  }[];
  marquee_series?: MarketDisplaySeriesRow[];
}

export interface RatesInstrumentsResponse {
  instruments: MarketDisplaySeriesRow[];
}
