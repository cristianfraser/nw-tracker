import { afterEach, describe, expect, it } from "vitest";
import {
  aggregationCacheHasForTest,
  clearAggregationCache,
  getAggregationCached,
  invalidateMarketDataAggregations,
  liveTierCached,
} from "./aggregationCache.js";
import {
  cacheDepNodeAffected,
  newCacheDepNode,
  noteLiveFxRead,
  noteLiveTickerRead,
} from "./cacheDependencies.js";

afterEach(() => clearAggregationCache());

const noMoves = { tickers: new Set<string>(), fx: false };

describe("cache dependencies", () => {
  it("a node is affected through any linked child, cycles included", () => {
    const leaf = newCacheDepNode();
    leaf.tickers.add("BTC-USD");
    const mid = newCacheDepNode();
    mid.children.add(leaf);
    const top = newCacheDepNode();
    top.children.add(mid);
    mid.children.add(top); // a cycle must not loop
    const other = newCacheDepNode();
    other.fx = true;
    const moves = { tickers: new Set(["BTC-USD"]), fx: false };
    const memo = new Map();
    expect(cacheDepNodeAffected(top, moves, memo)).toBe(true);
    expect(cacheDepNodeAffected(other, moves, memo)).toBe(false);
    expect(cacheDepNodeAffected(other, { tickers: new Set<string>(), fx: true }, new Map())).toBe(true);
    expect(cacheDepNodeAffected(top, noMoves, new Map())).toBe(false);
  });

  it("a scoped live tick drops only the entries that read a moved price, through nested hits", () => {
    // Keys under prefixes an unscoped tick drops.
    const coin = () => getAggregationCached("daily.series|t:coin", () => (noteLiveTickerRead("btc-usd"), 1));
    const dollar = () => getAggregationCached("daily.series|t:dollar", () => (noteLiveFxRead(), 2));
    const plain = () => getAggregationCached("daily.series|t:plain", () => 3);
    // Built after `coin` is already cached: depends on it through the hit.
    coin();
    const parent = () => getAggregationCached("daily.series|t:parent", () => coin() + plain());
    // A live-tier memo passes its reads on to entries built on a later hit.
    liveTierCached("t", "k", () => (noteLiveTickerRead("ETH-USD"), 0));
    const viaLiveTier = () => getAggregationCached("daily.series|t:live", () => liveTierCached("t", "k", () => 9));
    dollar();
    parent();
    viaLiveTier();

    invalidateMarketDataAggregations("live_tail", { tickers: new Set(["BTC-USD"]), fx: false });
    expect(aggregationCacheHasForTest("daily.series|t:coin")).toBe(false);
    expect(aggregationCacheHasForTest("daily.series|t:parent")).toBe(false);
    expect(aggregationCacheHasForTest("daily.series|t:plain")).toBe(true);
    expect(aggregationCacheHasForTest("daily.series|t:dollar")).toBe(true);
    expect(aggregationCacheHasForTest("daily.series|t:live")).toBe(true);

    invalidateMarketDataAggregations("live_tail", { tickers: new Set(["ETH-USD"]), fx: true });
    expect(aggregationCacheHasForTest("daily.series|t:dollar")).toBe(false);
    expect(aggregationCacheHasForTest("daily.series|t:live")).toBe(false);
    expect(aggregationCacheHasForTest("daily.series|t:plain")).toBe(true);
  });

  it("keeps what an unscoped tick keeps and never drops more", () => {
    getAggregationCached("depto.ledger|t", () => (noteLiveTickerRead("BTC-USD"), 1));
    invalidateMarketDataAggregations("live_tail", { tickers: new Set(["BTC-USD"]), fx: true });
    expect(aggregationCacheHasForTest("depto.ledger|t")).toBe(true);
  });
});
