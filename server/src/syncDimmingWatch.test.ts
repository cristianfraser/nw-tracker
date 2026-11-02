import { afterEach, describe, expect, it, vi } from "vitest";
import {
  aggregationCacheHasForTest,
  clearAggregationCache,
  getAggregationCached,
  invalidateMarketDataAggregations,
} from "./aggregationCache.js";
import { noteSyncDimmingRead } from "./cacheDependencies.js";
import * as globalSyncStale from "./globalSyncStale.js";
import { checkSyncDimmingChanged, resetSyncDimmingWatchForTest } from "./syncDimmingWatch.js";

const KEY = "dashboard.page_bundle|vitest_sync_dimming";

function cacheDimmingReader(): void {
  getAggregationCached(KEY, () => {
    noteSyncDimmingRead();
    return 1;
  });
}

function stubDimmed(sources: string[]) {
  vi.spyOn(globalSyncStale, "syncStatusPayload").mockReturnValue({
    stale_dimming: sources,
  } as unknown as ReturnType<typeof globalSyncStale.syncStatusPayload>);
}

afterEach(() => {
  vi.restoreAllMocks();
  resetSyncDimmingWatchForTest();
  clearAggregationCache();
});

describe("sync dimming as a cache input", () => {
  it("a price tick keeps a figure that read only the dimming", () => {
    cacheDimmingReader();
    invalidateMarketDataAggregations("live_tail", { tickers: new Set(["SPY"]), fx: true });
    expect(aggregationCacheHasForTest(KEY)).toBe(true);
  });

  it("a change of the dimmed set drops it; the first check and an unchanged set do not", () => {
    stubDimmed([]);
    cacheDimmingReader();
    expect(checkSyncDimmingChanged()).toBe(false);
    expect(checkSyncDimmingChanged()).toBe(false);
    expect(aggregationCacheHasForTest(KEY)).toBe(true);

    stubDimmed(["fintual"]);
    expect(checkSyncDimmingChanged()).toBe(true);
    expect(aggregationCacheHasForTest(KEY)).toBe(false);
  });
});
