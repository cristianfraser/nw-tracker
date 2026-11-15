/** Row shapes of `market_display_series`, apart from its readers so the watchlist modules can share them. */

export type WatchlistSource = "builtin" | "account" | "manual";

export type MarketDisplaySeriesRow = {
  id: number;
  slug: string;
  label: string;
  label_i18n_key: string | null;
  sort_order: number;
  kind: "equity" | "fund_unit" | "fx_usd" | "fx_pair" | "uf" | "composite";
  series_key: string | null;
  show_in_marquee: number;
  show_in_rates: number;
  rates_chart_title: string | null;
  source: WatchlistSource;
};
