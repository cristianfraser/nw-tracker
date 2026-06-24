import { describe, expect, it } from "vitest";
import {
  equityEarliestEodYmd,
  watchlistEquityHistoryNeedByYmd,
} from "./equityDailyWatchlistBackfill.js";

describe("watchlistEquityHistoryNeedByYmd", () => {
  it("uses the earlier of YoY calendar date and prior-year end for YTD", () => {
    expect(watchlistEquityHistoryNeedByYmd("2026-06-23")).toBe("2025-06-23");
    expect(watchlistEquityHistoryNeedByYmd("2026-02-10")).toBe("2025-02-10");
  });
});

describe("equityEarliestEodYmd", () => {
  it("returns null when ticker has no EOD rows", () => {
    expect(equityEarliestEodYmd("ZZZZ_NO_SUCH_TICKER")).toBeNull();
  });
});
