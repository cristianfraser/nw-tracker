import { afterEach, describe, expect, it } from "vitest";
import { db } from "./db.js";
import {
  equityTickersForMarqueeQuotes,
  getMarketTickerPayloadFromDb,
} from "./marketDisplaySeries.js";
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
    source: "builtin",
  };
}

describe("getMarketTickerPayloadFromDb day deltas", () => {
  afterEach(() => {
    db.prepare(`DELETE FROM fx_daily WHERE date >= '2099-01-01'`).run();
  });

  it("USD stays close-vs-prior-close when the latest fx row predates today (after midnight)", () => {
    const insert = db.prepare(`INSERT INTO fx_daily (date, clp_per_usd) VALUES (?, ?)`);
    insert.run("2099-01-04", 900);
    insert.run("2099-01-05", 927);

    // Chile calendar 2099-01-07: the latest fx row (Jan 5) is stale, like the
    // marquee after midnight before the next close lands. The 1D must match the
    // watchlist table (last session vs prior session), not zero out.
    const payload = getMarketTickerPayloadFromDb(new Date("2099-01-07T04:00:00-03:00"));

    expect(payload.chile_today).toBe("2099-01-07");
    expect(payload.usd?.date).toBe("2099-01-05");
    expect(payload.usd?.delta_pct).toBeCloseTo(3, 6);
  });
});

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
