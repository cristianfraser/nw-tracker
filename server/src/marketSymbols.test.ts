import { afterEach, describe, expect, it } from "vitest";
import { db } from "./db.js";
import { equityMarketKind, marketQuoteCurrency } from "./equityQuote.js";
import {
  marketSymbol,
  registerInstrument,
  reloadMarketSymbols,
  requireMarketSymbol,
  tickersInUse,
  unregisteredTickersInUse,
  type InstrumentFacts,
} from "./marketSymbols.js";
import { DEMO_TICKERS } from "./demoData/market.js";
import { testPerson } from "./demoData/person.js";

const T = "ZZREGTEST.XX";
const facts = (over: Partial<InstrumentFacts> = {}): InstrumentFacts => ({
  quote_currency: "usd",
  market_kind: "nyse",
  mic: "XNYS",
  exchange: null,
  name: "Registry test",
  instrument_type: "EQUITY",
  display_symbol: "ZZREGTEST",
  ...over,
});

afterEach(() => {
  db.prepare(`DELETE FROM equity_daily WHERE ticker = ?`).run(T);
  db.prepare(`DELETE FROM market_symbols WHERE ticker = ?`).run(T);
  reloadMarketSymbols();
});

describe("the instrument registry", () => {
  it("throws for an unregistered ticker, whatever its suffix", () => {
    for (const t of [T, "ZZNOREG", "ZZNOREG.SN", "ZZNOREG.L", "ZZNOREG-USD"]) {
      expect(() => requireMarketSymbol(t)).toThrow(/not registered in market_symbols; run `npm run register:market-symbols/);
      expect(() => equityMarketKind(t)).toThrow(/not registered/);
      expect(() => marketQuoteCurrency(t)).toThrow(/not registered/);
    }
  });

  it("a registered row decides market, currency and display symbol", () => {
    registerInstrument(T.toLowerCase(), facts({ market_kind: "london", mic: "XLON" }), "declared");
    expect(equityMarketKind(T)).toBe("london");
    expect(marketQuoteCurrency(T)).toBe("usd");
    expect(requireMarketSymbol(T)).toMatchObject({ ticker: T, mic: "XLON", display_symbol: "ZZREGTEST", source: "declared" });
  });

  it("finds a row another connection wrote (one reload before throwing)", () => {
    reloadMarketSymbols();
    db.prepare(
      `INSERT INTO market_symbols (ticker, quote_currency, market_kind, mic, isin, display_symbol, name, exchange, instrument_type, source, verified_at)
       VALUES (?, 'clp', 'santiago', 'XSGO', NULL, 'ZZREGTEST', NULL, NULL, NULL, 'yahoo', '2026-11-10T00:00:00.000Z')`
    ).run(T);
    expect(marketSymbol(T)).toBeNull(); // the cache does not know it yet
    expect(requireMarketSymbol(T).market_kind).toBe("santiago");
  });

  it("refuses to reframe a ticker with stored bars", () => {
    registerInstrument(T, facts(), "declared");
    db.prepare(`INSERT INTO equity_daily (ticker, trade_date, close, currency) VALUES (?, '2026-11-02', 10, 'usd')`).run(T);
    // Same facts again (a provider re-verifying it) is fine; a richer statement too.
    expect(registerInstrument(T, facts({ isin: "US0000000000" }), "yahoo").isin).toBe("US0000000000");
    expect(() => registerInstrument(T, facts({ market_kind: "london" }), "yahoo")).toThrow(/never reframe/);
    expect(() => registerInstrument(T, facts({ quote_currency: "clp" }), "yahoo")).toThrow(/never reframe/);
    expect(requireMarketSymbol(T).market_kind).toBe("nyse");
  });

  it("refuses a first registration whose currency is not the stored bars'", () => {
    db.prepare(`INSERT INTO equity_daily (ticker, trade_date, close, currency) VALUES (?, '2026-11-02', 10, 'clp')`).run(T);
    expect(() => registerInstrument(T, facts(), "yahoo")).toThrow(/1 equity_daily bar\(s\) in clp/);
    expect(marketSymbol(T)).toBeNull();
  });
});

describe("every ticker of the generated database is registered", () => {
  it("has a row for each ticker in use, the generator's declared", () => {
    expect(tickersInUse().length).toBeGreaterThan(0);
    expect(unregisteredTickersInUse()).toEqual([]);
    for (const t of testPerson("2026-11-10").brokerTickers) {
      const declared = DEMO_TICKERS.find((d) => d.ticker === t)!;
      expect(requireMarketSymbol(t)).toMatchObject({
        market_kind: declared.market_kind,
        quote_currency: declared.quote_currency,
        display_symbol: declared.display_symbol,
        mic: declared.mic,
      });
    }
  });
});
