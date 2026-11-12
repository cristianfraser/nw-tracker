import { describe, expect, it } from "vitest";
import { classifyYahooSymbol, yahooDisplaySymbol } from "./yahoo.js";

describe("classifyYahooSymbol", () => {
  it("reads an index as points on the US calendar", () => {
    const facts = classifyYahooSymbol("DX-Y.NYB", {
      regularMarketPrice: 102.067,
      currency: "USD",
      instrumentType: "INDEX",
      exchangeTimezoneName: "America/New_York",
      fullExchangeName: "ICE Futures",
      shortName: "US Dollar Index",
    });
    expect(facts).toMatchObject({ quote_currency: null, market_kind: "nyse", exchange: "ICE Futures", display_symbol: "DX-Y" });
  });

  it("reads a Santiago listing in pesos, and crypto on its own calendar", () => {
    expect(
      classifyYahooSymbol("ZZ.SN", {
        regularMarketPrice: 1000,
        currency: "CLP",
        instrumentType: "EQUITY",
        exchangeTimezoneName: "America/Santiago",
        exchangeName: "SGO",
        fullExchangeName: "Santiago",
      })
    ).toMatchObject({ quote_currency: "clp", market_kind: "santiago", display_symbol: "ZZ" });
    expect(
      classifyYahooSymbol("ZZ-USD", {
        regularMarketPrice: 1,
        currency: "USD",
        instrumentType: "CRYPTOCURRENCY",
        exchangeTimezoneName: "UTC",
        exchangeName: "CCC",
      })
    ).toMatchObject({ quote_currency: "usd", market_kind: "crypto24", display_symbol: "ZZ-USD" });
  });

  it("reads a London line in dollars as london/usd and refuses one in pence", () => {
    const meta = {
      regularMarketPrice: 600,
      currency: "USD",
      instrumentType: "ETF",
      exchangeTimezoneName: "Europe/London",
      exchangeName: "LSE",
      fullExchangeName: "LSE",
    };
    expect(classifyYahooSymbol("ZZUC.L", meta)).toMatchObject({ quote_currency: "usd", market_kind: "london", display_symbol: "ZZUC" });
    expect(() => classifyYahooSymbol("ZZGB.L", { ...meta, currency: "GBp" })).toThrow(/quoted in GBp/);
  });

  it("accepts any currency the currencies table holds and refuses the rest", () => {
    expect(
      classifyYahooSymbol("ZZ", { regularMarketPrice: 1, currency: "EUR", instrumentType: "EQUITY", exchangeTimezoneName: "America/New_York" })
    ).toMatchObject({ quote_currency: "eur", market_kind: "nyse" });
    expect(() =>
      classifyYahooSymbol("ZZ", { regularMarketPrice: 1, currency: "JPY", instrumentType: "EQUITY", exchangeTimezoneName: "America/New_York" })
    ).toThrow(/JPY, which is not in the currencies table/);
    expect(() =>
      classifyYahooSymbol("ZZ", { regularMarketPrice: 1, currency: null, instrumentType: "EQUITY", exchangeTimezoneName: "America/New_York" })
    ).toThrow(/no currency/);
  });

  it("refuses a dead listing and another exchange", () => {
    // Yahoo's `DXY`: a Nasdaq stub with no currency and no price.
    expect(() =>
      classifyYahooSymbol("DXY", { currency: null, instrumentType: "ECNQUOTE", exchangeTimezoneName: "America/New_York" })
    ).toThrow(/no price/);
    expect(() =>
      classifyYahooSymbol("ZZ.T", { regularMarketPrice: 1, currency: "JPY", instrumentType: "EQUITY", exchangeTimezoneName: "Asia/Tokyo" })
    ).toThrow(/Asia\/Tokyo/);
    expect(() =>
      classifyYahooSymbol("ZZ", { regularMarketPrice: 1, currency: "USD", instrumentType: "EQUITY" })
    ).toThrow(/unknown time zone/);
  });
});

describe("yahooDisplaySymbol", () => {
  it("strips a known exchange suffix and keeps everything else whole", () => {
    expect(yahooDisplaySymbol("CFIETFIPSA.SN")).toBe("CFIETFIPSA");
    expect(yahooDisplaySymbol("cspx.l")).toBe("CSPX");
    expect(yahooDisplaySymbol("SPY")).toBe("SPY");
    expect(yahooDisplaySymbol("BTC-USD")).toBe("BTC-USD");
    expect(yahooDisplaySymbol("^GSPC")).toBe("^GSPC");
    expect(yahooDisplaySymbol("BRK.B")).toBe("BRK.B");
  });
});
