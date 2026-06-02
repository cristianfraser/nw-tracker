import { describe, expect, it } from "vitest";
import { db } from "./db.js";
import { equityTickersForMarqueeQuotes } from "./marketDisplaySeries.js";
import type { MarketDisplaySeriesRow } from "./marketDisplaySeries.js";

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
  };
}

describe("equityTickersForMarqueeQuotes", () => {
  it("merges marquee config with distinct accounts.equity_ticker values", () => {
    const tickers = equityTickersForMarqueeQuotes([
      equityRow("SPY"),
      equityRow("VEA"),
      equityRow("BTC-USD"),
      equityRow("ETH-USD"),
    ]);
    expect(tickers).toContain("SPY");
    expect(tickers).toContain("BTC-USD");
    const hasOilk = db
      .prepare(`SELECT 1 FROM accounts WHERE equity_ticker = 'OILK' LIMIT 1`)
      .get();
    if (hasOilk) expect(tickers).toContain("OILK");
  });
});
