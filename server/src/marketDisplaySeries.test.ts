import { describe, expect, it } from "vitest";
import { equityTickersForMarqueeQuotes } from "./marketDisplaySeries.js";import type { MarketDisplaySeriesRow } from "./marketDisplaySeries.js";

function equityRow(series_key: string): MarketDisplaySeriesRow {
  return {
    id: 0,
    slug: series_key.toLowerCase(),
    label: series_key,
    label_i18n_key: null,
    sort_order: 0,
    kind: "equity",
    series_key,
    show_in_marquee: 1,
    show_in_rates: 1,
    rates_chart_title: series_key,
    source: "builtin",
  };
}

describe("equityTickersForMarqueeQuotes", () => {
  it("returns only marquee-enabled equity series keys", () => {
    const tickers = equityTickersForMarqueeQuotes([
      equityRow("SPY"),
      equityRow("VEA"),
      { ...equityRow("OILK"), show_in_marquee: 0 },
      equityRow("BTC-USD"),
      equityRow("ETH-USD"),
    ]);
    expect(tickers).toContain("SPY");
    expect(tickers).toContain("BTC-USD");
    expect(tickers).not.toContain("OILK");
  });
});
