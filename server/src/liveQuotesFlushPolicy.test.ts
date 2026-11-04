import { describe, expect, it } from "vitest";
import { nextUnitDueAtMs, pickNextFlush, type FlushInput, type StreamPrice, type WrittenPrice } from "./liveQuotesFlushPolicy.js";

const NOW = 1_000_000;
const q = (symbol: string, price: number): StreamPrice => ({ symbol, price, timeMs: NOW, previousClose: null });
const w = (symbol: string, price: number, atMs: number): [string, WrittenPrice] => [symbol, { quote: q(symbol, price), atMs }];

function input(over: Partial<FlushInput>): FlushInput {
  return {
    nowMs: NOW,
    pending: new Map(),
    written: new Map(),
    unitOf: new Map(),
    unitDueAtMs: new Map(),
    lastChangeWriteAtMs: null,
    covered: new Set(),
    minFlushGapMs: 5_000,
    restampAfterMs: 180_000,
    ...over,
  };
}

describe("pickNextFlush", () => {
  it("writes every symbol that really moved, together", () => {
    const plan = pickNextFlush(
      input({
        pending: new Map([
          ["SPY", q("SPY", 767.5)],
          ["VEA", q("VEA", 70.73)],
          ["SLV", q("SLV", 47.2)],
        ]),
        written: new Map([w("SPY", 767.49, NOW - 60_000), w("VEA", 70.73, NOW - 60_000), w("SLV", 47.1, NOW - 60_000)]),
      })
    );
    expect(plan.changes.map((c) => c.symbol)).toEqual(["SLV", "SPY"]);
    expect(plan.units).toEqual(["SLV", "SPY"]);
  });

  it("holds a symbol until its next write is due", () => {
    const plan = pickNextFlush(
      input({
        pending: new Map([["SPY", q("SPY", 768)]]),
        written: new Map([w("SPY", 767.49, NOW - 10_000)]),
        unitDueAtMs: new Map([["SPY", NOW + 20_000]]),
      })
    );
    expect(plan.changes).toEqual([]);
  });

  it("writes nothing sooner than the gap after the last change", () => {
    const plan = pickNextFlush(
      input({ pending: new Map([["BTC-USD", q("BTC-USD", 80_000)]]), lastChangeWriteAtMs: NOW - 2_000 })
    );
    expect(plan.changes).toEqual([]);
  });

  it("writes a basket's moved members together, once per interval", () => {
    const unitOf = new Map([
      ["SPY", "basket"],
      ["EFA", "basket"],
      ["XLE", "basket"],
    ]);
    const pending = new Map([
      ["SPY", q("SPY", 768)],
      ["EFA", q("EFA", 90)],
      ["XLE", q("XLE", 95)],
    ]);
    const written = new Map([w("SPY", 767, NOW - 40_000), w("EFA", 90, NOW - 40_000), w("XLE", 94, NOW - 40_000)]);
    const due = pickNextFlush(input({ pending, written, unitOf, unitDueAtMs: new Map([["basket", NOW - 1]]) }));
    expect(due.changes.map((c) => c.symbol)).toEqual(["SPY", "XLE"]);
    expect(due.units).toEqual(["basket"]);
    const held = pickNextFlush(input({ pending, written, unitOf, unitDueAtMs: new Map([["basket", NOW + 10_000]]) }));
    expect(held.changes).toEqual([]);
  });

  it("re-stamps a covered quiet symbol's row before it goes stale, at its written price", () => {
    const plan = pickNextFlush(
      input({
        pending: new Map([["CLP=X", q("CLP=X", 967.32)]]),
        written: new Map([w("CLP=X", 967.32, NOW - 200_000), w("CFIETFIPSA.SN", 1275.4, NOW - 200_000), w("VEA", 70, NOW - 10_000)]),
        covered: new Set(["CLP=X", "VEA"]),
      })
    );
    expect(plan.changes).toEqual([]);
    expect(plan.restamps.map((r) => [r.symbol, r.price])).toEqual([["CLP=X", 967.32]]);
  });

  it("re-stamps while a change waits for its interval", () => {
    const plan = pickNextFlush(
      input({
        pending: new Map([["SPY", q("SPY", 770)]]),
        written: new Map([w("SPY", 767.49, NOW - 200_000)]),
        unitDueAtMs: new Map([["SPY", NOW - 1]]),
        lastChangeWriteAtMs: NOW - 1_000,
        covered: new Set(["SPY"]),
      })
    );
    expect(plan.changes).toEqual([]);
    expect(plan.restamps.map((r) => r.price)).toEqual([767.49]);
  });

  it("spreads the next due time over the interval", () => {
    expect(nextUnitDueAtMs(NOW, 30_000, 30_000, 0)).toBe(NOW + 30_000);
    expect(nextUnitDueAtMs(NOW, 30_000, 30_000, 0.999)).toBe(NOW + 59_970);
  });
});
