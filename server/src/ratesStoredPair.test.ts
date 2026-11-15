import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "./db.js";
import {
  convertFlowOrNull,
  pairBidAskOnOrBefore,
  pairKeepsBidAsk,
  referenceAmountAtMid,
  storedPairRate,
  storedPairRatesInRange,
  storedPairRatesOnOrBefore,
} from "./rates.js";

// Isolated fixture window centuries before any real rate data (the series start 2016+, other
// fixtures use 2020+/2099 dates), so on-or-before lookups are deterministic.
const USD_CLP_ROWS: ReadonlyArray<[date: string, clpPerUsd: number]> = [
  ["1700-01-15", 700],
  ["1700-01-31", 710],
  ["1700-02-10", 720],
];
const EUR_USD_ROWS: ReadonlyArray<[date: string, usdPerEur: number]> = [
  ["1700-01-15", 1.25],
  ["1700-02-10", 1.6],
];
const UF_ROWS: ReadonlyArray<[date: string, clpPerUf: number]> = [
  ["1700-01-15", 30],
  ["1700-01-16", 31],
  ["1700-02-10", 32],
];

beforeAll(() => {
  const insFx = db.prepare(`INSERT OR REPLACE INTO fx_daily (date, clp_per_usd) VALUES (?, ?)`);
  for (const [date, v] of USD_CLP_ROWS) insFx.run(date, v);
  const insPair = db.prepare(`INSERT OR REPLACE INTO fx_rates (base, quote, date, mid, source) VALUES ('eur', 'usd', ?, ?, 'vitest')`);
  for (const [date, v] of EUR_USD_ROWS) insPair.run(date, v);
  const insUf = db.prepare(`INSERT OR REPLACE INTO uf_daily (date, clp_per_uf) VALUES (?, ?)`);
  for (const [date, v] of UF_ROWS) insUf.run(date, v);
});

afterAll(() => {
  db.prepare(`DELETE FROM fx_daily WHERE date LIKE '17%'`).run();
  db.prepare(`DELETE FROM fx_rates WHERE date LIKE '17%'`).run();
  db.prepare(`DELETE FROM uf_daily WHERE date LIKE '17%'`).run();
});

describe("storedPairRate", () => {
  it("returns the latest stored row on or before the date, for any direct pair", () => {
    expect(storedPairRate("usd", "clp", "1700-02-12")).toEqual({ date: "1700-02-10", mid: 720 });
    expect(storedPairRate("usd", "clp", "1700-02-10")).toEqual({ date: "1700-02-10", mid: 720 });
    expect(storedPairRate("eur", "usd", "1700-02-01")).toEqual({ date: "1700-01-15", mid: 1.25 });
    expect(storedPairRate("uf", "clp", "1700-01-20")).toEqual({ date: "1700-01-16", mid: 31 });
  });

  it("reads a pair named the other way round as the reciprocal", () => {
    expect(storedPairRate("usd", "eur", "1700-02-01")).toEqual({ date: "1700-01-15", mid: 0.8 });
  });

  it("never reads a rate dated after the date: null before the series starts and for a null date", () => {
    expect(storedPairRate("usd", "clp", "1699-12-31")).toBeNull();
    expect(storedPairRate("eur", "usd", "1699-12-31")).toBeNull();
    expect(storedPairRate("usd", "clp", null)).toBeNull();
  });

  it("throws for two codes with no direct pair", () => {
    expect(() => storedPairRate("uf", "usd", "1700-02-01")).toThrow(/no direct pair uf\/usd/);
  });
});

describe("stored pair rows over many dates", () => {
  it("storedPairRatesInRange lists exact dates only", () => {
    expect([...storedPairRatesInRange("uf", "clp", "1700-01-16", "1700-02-09")]).toEqual([["1700-01-16", 31]]);
    expect(storedPairRatesInRange("uf", "clp", "1700-02-01", "1700-01-01").size).toBe(0);
  });

  it("storedPairRatesOnOrBefore carries the last row forward, by an indexed read or one pass", () => {
    const few = ["1699-12-31", "1700-01-15", "1700-01-20", "1700-03-01"];
    const expected = new Map([
      ["1700-01-15", 30],
      ["1700-01-20", 31],
      ["1700-03-01", 32],
    ]);
    expect(storedPairRatesOnOrBefore("uf", "clp", few)).toEqual(expected);
    // More than the indexed-lookup limit: the one-pass read answers the same.
    const many = [...Array.from({ length: 20 }, (_, i) => `1699-11-${String(i + 1).padStart(2, "0")}`), ...few];
    expect(storedPairRatesOnOrBefore("uf", "clp", many)).toEqual(expected);
    expect(storedPairRatesOnOrBefore("eur", "usd", few).get("1700-03-01")).toBe(1.6);
  });
});

describe("bid/ask is per pair", () => {
  it("only a pair that keeps buy and sell rates has them; the others have no spread", () => {
    expect(pairKeepsBidAsk("usd", "clp")).toBe(true);
    expect(pairKeepsBidAsk("eur", "usd")).toBe(false);
    expect(pairKeepsBidAsk("eur", "clp")).toBe(false);
    expect(pairKeepsBidAsk("uf", "clp")).toBe(false);
    expect(pairBidAskOnOrBefore("eur", "usd", "1700-02-01")).toBeNull();
  });

  it("a flow buying the base of a pair with bid/ask pays the buy rate; any other pair converts at the mid", () => {
    const ba = pairBidAskOnOrBefore("usd", "clp", "1700-02-01");
    expect(ba).not.toBeNull();
    expect(ba!.ask).toBeGreaterThan(ba!.bid);
    expect(convertFlowOrNull(71_000, "clp", "usd", "1700-02-01")).toBe(71_000 / ba!.ask);
    // Dollars into pesos, and both ways across a pair with no spread: the stored mid.
    expect(convertFlowOrNull(100, "usd", "clp", "1700-02-01")).toBe(71_000);
    expect(convertFlowOrNull(100, "eur", "usd", "1700-02-01")).toBe(125);
    expect(convertFlowOrNull(125, "usd", "eur", "1700-02-01")).toBe(100);
    expect(convertFlowOrNull(100, "usd", "clp", "1699-12-31")).toBeNull();
  });
});

describe("referenceAmountAtMid", () => {
  it("is the size of the amount at the stored mid, for any pair", () => {
    expect(referenceAmountAtMid(-100, "usd", "clp", "1700-02-01")).toBe(71_000);
    expect(referenceAmountAtMid(100, "eur", "usd", "1700-02-01")).toBe(125);
    expect(referenceAmountAtMid(0, "eur", "usd", "1700-02-01")).toBe(0);
    expect(referenceAmountAtMid(100, "eur", "usd", "1699-12-31")).toBeNull();
  });
});
