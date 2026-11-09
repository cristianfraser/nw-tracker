import { describe, expect, it } from "vitest";
import {
  attachLiveInputs,
  liveInputsOf,
  parseLiveInputs,
  queryReadsMovedPrice,
  shareKeepingLiveInputs,
  type LiveQuoteMoves,
} from "./liveInputs";

const moves = (over: Partial<LiveQuoteMoves>): LiveQuoteMoves => ({
  all: false,
  tickers: [],
  fx: false,
  dimming: false,
  ...over,
});

describe("parseLiveInputs", () => {
  it("reads tickers and the special inputs", () => {
    const inputs = parseLiveInputs("$dimming,$fx,BTC-USD,spy");
    expect(inputs?.fx).toBe(true);
    expect(inputs?.dimming).toBe(true);
    expect([...(inputs?.tickers ?? [])]).toEqual(["BTC-USD", "SPY"]);
  });
});

describe("queryReadsMovedPrice", () => {
  const spyPage = attachLiveInputs({ rows: [] }, parseLiveInputs("SPY"));
  const usdPage = attachLiveInputs({ rows: [] }, parseLiveInputs("$fx,VEA"));
  const staticPage = attachLiveInputs({ rows: [] }, parseLiveInputs("none"));

  it("refetches only what read a moved price", () => {
    expect(queryReadsMovedPrice(spyPage, moves({ tickers: ["spy"] }))).toBe(true);
    expect(queryReadsMovedPrice(spyPage, moves({ tickers: ["BTC-USD"] }))).toBe(false);
    expect(queryReadsMovedPrice(usdPage, moves({ fx: true }))).toBe(true);
    expect(queryReadsMovedPrice(spyPage, moves({ fx: true }))).toBe(false);
    expect(queryReadsMovedPrice(staticPage, moves({ tickers: ["SPY"], fx: true, dimming: true }))).toBe(false);
  });

  it("refetches the dimming's readers when it changes", () => {
    const dimmed = attachLiveInputs({}, parseLiveInputs("$dimming"));
    expect(queryReadsMovedPrice(dimmed, moves({ dimming: true }))).toBe(true);
  });

  it("refetches everything on an everything-moved, and unknown inputs on any move", () => {
    expect(queryReadsMovedPrice(staticPage, moves({ all: true }))).toBe(true);
    expect(queryReadsMovedPrice({ rows: [] }, moves({ tickers: ["SPY"] }))).toBe(true);
    expect(queryReadsMovedPrice(42, moves({ tickers: ["SPY"] }))).toBe(true);
  });
});

describe("shareKeepingLiveInputs", () => {
  it("keeps the new inputs when the new data equals the old", () => {
    const oldData = attachLiveInputs({ a: 1 }, parseLiveInputs("SPY"));
    const newData = attachLiveInputs({ a: 1 }, parseLiveInputs("SPY,VEA"));
    const shared = shareKeepingLiveInputs(oldData, newData);
    expect(shared).toBe(oldData);
    expect([...(liveInputsOf(shared)?.tickers ?? [])]).toEqual(["SPY", "VEA"]);
  });

  it("keeps them on a partly shared object and on arrays", () => {
    const oldData = attachLiveInputs({ a: { x: 1 }, b: 1 }, parseLiveInputs("SPY"));
    const newData = attachLiveInputs({ a: { x: 1 }, b: 2 }, parseLiveInputs("$fx"));
    expect(liveInputsOf(shareKeepingLiveInputs(oldData, newData))?.fx).toBe(true);
    const oldList = attachLiveInputs([1, 2], parseLiveInputs("SPY"));
    const newList = attachLiveInputs([1, 2], parseLiveInputs("none"));
    expect(liveInputsOf(shareKeepingLiveInputs(oldList, newList))?.tickers.size).toBe(0);
  });

  it("leaves the payload's own fields as they are", () => {
    const data = attachLiveInputs({ a: 1 }, parseLiveInputs("SPY"));
    expect(Object.keys(data)).toEqual(["a"]);
    expect(JSON.stringify(data)).toBe('{"a":1}');
  });
});
