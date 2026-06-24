import type { MarketDisplaySeriesRow } from "./marketDisplaySeries.js";
import { loadCompositeHoldings } from "./watchlistComposite.js";
import { watchlistStatsForRow, type WatchlistRowStats } from "./watchlistStats.js";

export type WatchlistCompositeHoldingRow = WatchlistRowStats & {
  ticker: string;
  weight: number;
};

function syntheticEquityRow(ticker: string): MarketDisplaySeriesRow {
  return {
    id: 0,
    slug: `composite_holding_${ticker.toLowerCase()}`,
    label: ticker,
    label_i18n_key: null,
    sort_order: 0,
    kind: "equity",
    series_key: ticker,
    show_in_marquee: 0,
    show_in_rates: 0,
    rates_chart_title: null,
    source: "builtin",
  };
}

export function compositeHoldingsWithStats(
  bucketSlug: string,
  now = new Date()
): WatchlistCompositeHoldingRow[] {
  const holdings = loadCompositeHoldings(bucketSlug);
  return holdings.map((h) => {
    const stats = watchlistStatsForRow(syntheticEquityRow(h.ticker), now);
    return {
      ticker: h.ticker,
      weight: h.weight,
      ...stats,
    };
  });
}
