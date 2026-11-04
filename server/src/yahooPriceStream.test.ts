import { describe, expect, it } from "vitest";
import { streamTickInSession } from "./yahooPriceStream.js";
import type { YahooPricingTick } from "./yahooPricingData.js";

const tick = (symbol: string, at: string, marketHours: YahooPricingTick["marketHours"] = "regular"): YahooPricingTick => ({
  symbol,
  price: 100,
  timeMs: Date.parse(at),
  marketHours,
  previousClose: null,
});

// 2026-06-01 is a Monday: NYSE open 13:30–20:00 UTC, Santiago 09:30–17:05 Chile (UTC−4).
const NYSE_OPEN = new Date("2026-06-01T16:00:00Z");
const SATURDAY = new Date("2026-06-06T16:00:00Z");

describe("streamTickInSession", () => {
  it("keeps a regular NYSE print of today's session while it is open", () => {
    expect(streamTickInSession(tick("SPY", "2026-06-01T15:59:58Z"), NYSE_OPEN)).toBe(true);
  });

  it("drops pre- and post-market prints", () => {
    expect(streamTickInSession(tick("SPY", "2026-06-01T15:59:58Z", "post"), NYSE_OPEN)).toBe(false);
    expect(streamTickInSession(tick("SPY", "2026-06-01T15:59:58Z", "pre"), NYSE_OPEN)).toBe(false);
  });

  it("drops a print from an earlier session (a subscribe snapshot)", () => {
    expect(streamTickInSession(tick("SPY", "2026-05-29T19:59:00Z"), NYSE_OPEN)).toBe(false);
  });

  it("drops NYSE prints while the market is closed, keeps crypto", () => {
    expect(streamTickInSession(tick("SPY", "2026-06-06T15:59:00Z"), SATURDAY)).toBe(false);
    expect(streamTickInSession(tick("BTC-USD", "2026-06-06T15:59:00Z"), SATURDAY)).toBe(true);
  });

  it("keeps a Santiago print only in the Chile session", () => {
    expect(streamTickInSession(tick("CFIETFIPSA.SN", "2026-06-01T15:00:00Z"), NYSE_OPEN)).toBe(true);
    expect(streamTickInSession(tick("CFIETFIPSA.SN", "2026-06-01T23:00:00Z"), new Date("2026-06-01T23:30:00Z"))).toBe(false);
  });

  it("keeps the dollar only while its fx day is open", () => {
    expect(streamTickInSession(tick("CLP=X", "2026-06-01T15:59:00Z"), NYSE_OPEN)).toBe(true);
    expect(streamTickInSession(tick("CLP=X", "2026-06-06T15:59:00Z"), SATURDAY)).toBe(false);
  });
});
