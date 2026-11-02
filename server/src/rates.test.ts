import { afterAll, describe, expect, it } from "vitest";
import { db } from "./db.js";
import { holdingFromFacts, type HoldingFacts } from "./holdings.js";
import { convertCurrency, rateAt } from "./rates.js";
import { snapshotTables } from "./test/snapshotTables.js";

const restoreTables = snapshotTables(["fx_daily", "fx_daily_bid_ask", "uf_daily", "eur_daily"]);
afterAll(() => restoreTables());

// Far-future days read as stored days with a clock past them.
const NOW = new Date("2100-06-01T15:00:00Z");
const D = "2099-09-01";

function seed(): void {
  db.prepare(`DELETE FROM fx_daily_bid_ask WHERE date >= '2099-01-01'`).run();
  db.prepare(`INSERT OR REPLACE INTO fx_daily (date, clp_per_usd) VALUES (?, 1000)`).run(D);
  db.prepare(`INSERT OR REPLACE INTO uf_daily (date, clp_per_uf) VALUES (?, 40000)`).run(D);
  db.prepare(`INSERT OR REPLACE INTO eur_daily (date, clp_per_eur) VALUES (?, 1100)`).run(D);
}

describe("convertCurrency", () => {
  it("asset: USD→CLP at the bid, CLP→USD at the ask; debt flips; mid is the mid", () => {
    seed();
    const asset = { side: "asset" as const, now: NOW };
    const debt = { side: "debt" as const, now: NOW };
    expect(convertCurrency(10, "usd", "clp", D, asset)).toBe(9980);
    expect(convertCurrency(10020, "clp", "usd", D, asset)).toBe(10);
    expect(convertCurrency(10, "usd", "clp", D, debt)).toBe(10020);
    expect(convertCurrency(9980, "clp", "usd", D, debt)).toBe(10);
    expect(convertCurrency(10, "usd", "clp", D, { side: "mid", now: NOW })).toBe(10000);
  });

  it("an observed bid/ask on the mid's day is used; an older one is not", () => {
    seed();
    db.prepare(
      `INSERT INTO fx_daily_bid_ask (date, buy_clp_per_usd, sell_clp_per_usd, source) VALUES (?, 1010, 990, 'manual')`
    ).run(D);
    expect(rateAt("usd", "clp", D, { side: "asset", now: NOW })).toBe(990);
    db.prepare(`INSERT OR REPLACE INTO fx_daily (date, clp_per_usd) VALUES ('2099-09-02', 1000)`).run();
    expect(rateAt("usd", "clp", "2099-09-02", { side: "asset", now: NOW })).toBe(998);
    db.prepare(`DELETE FROM fx_daily WHERE date = '2099-09-02'`).run();
  });

  it("UF and EUR have no spread; a pair without a direct link walks through the shared code", () => {
    seed();
    expect(convertCurrency(2, "uf", "clp", D, { side: "asset", now: NOW })).toBe(80000);
    expect(convertCurrency(80000, "clp", "uf", D, { side: "debt", now: NOW })).toBe(2);
    // 40 USD at the bid (998) = 39.920 CLP = 0,998 UF.
    expect(convertCurrency(40, "usd", "uf", D, { side: "asset", now: NOW })).toBeCloseTo(0.998, 10);
    expect(convertCurrency(1100, "clp", "eur", D, { side: "asset", now: NOW })).toBe(1);
  });

  it("same code and zero pass through; a missing rate is null", () => {
    expect(convertCurrency(5, "usd", "usd", "1900-01-01", { side: "asset" })).toBe(5);
    expect(convertCurrency(0, "usd", "clp", "1900-01-01", { side: "asset" })).toBe(0);
    expect(convertCurrency(5, "uf", "clp", "1900-01-01", { side: "asset" })).toBeNull();
  });
});

describe("holdingFromFacts", () => {
  const base: HoldingFacts = {
    kindSlug: "clp",
    importKey: null,
    equityTicker: null,
    coinPriceTicker: null,
    usesEquityMtm: false,
    fundSeriesKey: null,
    quoteCurrencyOf: (t) => (t.endsWith(".SN") ? "clp" : "usd"),
  };

  it("maps each kind of account to what it holds", () => {
    expect(holdingFromFacts({ ...base, kindSlug: "usd" })).toEqual({ kind: "currency", code: "usd" });
    expect(holdingFromFacts({ ...base, kindSlug: "cuenta_corriente" })).toEqual({ kind: "currency", code: "clp" });
    expect(holdingFromFacts({ ...base, kindSlug: "property" })).toEqual({ kind: "currency", code: "uf" });
    expect(holdingFromFacts({ ...base, kindSlug: "credit_card" })).toEqual({ kind: "card" });
    expect(holdingFromFacts({ ...base, kindSlug: "spy", equityTicker: "SPY", usesEquityMtm: true })).toEqual({
      kind: "stock",
      ticker: "SPY",
      quote: "usd",
    });
    expect(
      holdingFromFacts({ ...base, kindSlug: "ipsa", equityTicker: "CFIETFIPSA.SN", usesEquityMtm: true })
    ).toEqual({ kind: "stock", ticker: "CFIETFIPSA.SN", quote: "clp" });
    expect(holdingFromFacts({ ...base, kindSlug: "btc", equityTicker: "BTC-USD", coinPriceTicker: "BTC-USD" })).toEqual({
      kind: "coin",
      coin: "BTC",
      priceTicker: "BTC-USD",
      quote: "usd",
    });
    expect(holdingFromFacts({ ...base, kindSlug: "afp" })).toEqual({
      kind: "fund",
      seriesKey: "afp_uno_cuota_a",
      quote: "clp",
    });
    expect(holdingFromFacts({ ...base, kindSlug: "afc" })).toEqual({ kind: "currency", code: "clp" });
  });

  it("a Fintual fund account without its series throws", () => {
    expect(() =>
      holdingFromFacts({ ...base, kindSlug: "mutual_fund", importKey: "import:fintual|cert|key=x" })
    ).toThrow(/fund_series_key/);
  });
});
