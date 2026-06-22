import { describe, expect, it } from "vitest";
import {
  aggregateCoinGeckoPricesToUtcDaily,
  coingeckoIdForCryptoTicker,
  mergeEodCloseSeriesPreferPrimary,
} from "./equityCoinGeckoEod.js";

describe("aggregateCoinGeckoPricesToUtcDaily", () => {
  it("keeps the last sample per UTC day", () => {
    const series = aggregateCoinGeckoPricesToUtcDaily([
      [Date.parse("2026-06-14T10:00:00Z"), 100],
      [Date.parse("2026-06-14T22:00:00Z"), 110],
      [Date.parse("2026-06-15T08:00:00Z"), 120],
    ]);
    expect(series).toEqual({
      dates: ["2026-06-14", "2026-06-15"],
      closes: [110, 120],
    });
  });

  it("includes weekend days when samples exist", () => {
    const series = aggregateCoinGeckoPricesToUtcDaily([
      [Date.parse("2026-06-13T23:59:00Z"), 90],
      [Date.parse("2026-06-14T12:00:00Z"), 95],
      [Date.parse("2026-06-15T12:00:00Z"), 98],
    ]);
    expect(series.dates).toEqual(["2026-06-13", "2026-06-14", "2026-06-15"]);
  });
});

describe("mergeEodCloseSeriesPreferPrimary", () => {
  it("prefers primary closes on overlapping dates", () => {
    const merged = mergeEodCloseSeriesPreferPrimary(
      { dates: ["2026-06-14", "2026-06-15"], closes: [100, 110] },
      { dates: ["2026-06-13", "2026-06-14"], closes: [80, 90] }
    );
    expect(merged).toEqual({
      dates: ["2026-06-13", "2026-06-14", "2026-06-15"],
      closes: [80, 100, 110],
    });
  });
});

describe("coingeckoIdForCryptoTicker", () => {
  it("maps BTC-USD and ETH-USD", () => {
    expect(coingeckoIdForCryptoTicker("BTC-USD")).toBe("bitcoin");
    expect(coingeckoIdForCryptoTicker("ETH-USD")).toBe("ethereum");
  });

  it("throws for unknown tickers", () => {
    expect(() => coingeckoIdForCryptoTicker("DOGE-USD")).toThrow(/No CoinGecko id/);
  });
});
