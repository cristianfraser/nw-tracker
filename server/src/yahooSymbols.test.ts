import { describe, expect, it } from "vitest";
import { classifyYahooSymbol } from "./yahooSymbols.js";

const NOW = new Date("2026-10-04T12:00:00Z");

describe("classifyYahooSymbol", () => {
  it("reads an index as points on the US calendar", () => {
    const row = classifyYahooSymbol(
      "DX-Y.NYB",
      {
        regularMarketPrice: 102.067,
        currency: "USD",
        instrumentType: "INDEX",
        exchangeTimezoneName: "America/New_York",
        fullExchangeName: "ICE Futures",
        shortName: "US Dollar Index",
      },
      NOW
    );
    expect(row).toMatchObject({ ticker: "DX-Y.NYB", quote_currency: "none", market_kind: "nyse", exchange: "ICE Futures" });
  });

  it("reads a Santiago listing in pesos and crypto on its own calendar", () => {
    expect(
      classifyYahooSymbol("ZZ.SN", {
        regularMarketPrice: 1000,
        currency: "CLP",
        instrumentType: "EQUITY",
        exchangeTimezoneName: "America/Santiago",
      })
    ).toMatchObject({ quote_currency: "clp", market_kind: "santiago" });
    expect(
      classifyYahooSymbol("ZZ-USD", {
        regularMarketPrice: 1,
        currency: "USD",
        instrumentType: "CRYPTOCURRENCY",
        exchangeTimezoneName: "UTC",
      })
    ).toMatchObject({ quote_currency: "usd", market_kind: "crypto24" });
  });

  it("refuses a dead listing, another currency, and another exchange", () => {
    // Yahoo's `DXY`: a Nasdaq stub with no currency and no price.
    expect(() =>
      classifyYahooSymbol("DXY", { currency: null, instrumentType: "ECNQUOTE", exchangeTimezoneName: "America/New_York" })
    ).toThrow(/no price/);
    expect(() =>
      classifyYahooSymbol("ZZ", { regularMarketPrice: 1, currency: "EUR", instrumentType: "EQUITY", exchangeTimezoneName: "America/New_York" })
    ).toThrow(/EUR/);
    expect(() =>
      classifyYahooSymbol("ZZ.T", { regularMarketPrice: 1, currency: "JPY", instrumentType: "EQUITY", exchangeTimezoneName: "Asia/Tokyo" })
    ).toThrow(/Asia\/Tokyo/);
  });
});
