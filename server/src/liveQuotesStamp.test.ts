import { beforeEach, describe, expect, it } from "vitest";
import {
  liveQuoteMovesSince,
  liveQuotesStamp,
  noteLiveQuotesChanged,
  resetLiveQuotesStampForTest,
} from "./liveQuotesStamp.js";

const BOOT = "2026-11-04T13:00:00.000Z";

beforeEach(() => resetLiveQuotesStampForTest(BOOT));

describe("liveQuotesStamp", () => {
  it("publishes a change at once and never moves the stamp back", () => {
    expect(liveQuotesStamp()).toBeNull();
    noteLiveQuotesChanged("2026-11-04T13:30:20.000Z", { tickers: ["SPY"] });
    expect(liveQuotesStamp()).toBe("2026-11-04T13:30:20.000Z");
    noteLiveQuotesChanged("2026-11-04T13:30:10.000Z", { fx: ["USD_CLP"] });
    expect(liveQuotesStamp()).toBe("2026-11-04T13:30:20.000Z");
  });

  it("answers the union of what moved after a stamp the client saw", () => {
    noteLiveQuotesChanged("2026-11-04T13:30:00.000Z", { tickers: ["btc-usd"] });
    noteLiveQuotesChanged("2026-11-04T13:30:05.000Z", { tickers: ["SPY", "VEA"] });
    noteLiveQuotesChanged("2026-11-04T13:30:10.000Z", { fx: ["EUR_USD"] });
    noteLiveQuotesChanged("2026-11-04T13:30:12.000Z", { fx: ["USD_CLP"] });
    noteLiveQuotesChanged("2026-11-04T13:30:15.000Z", { tickers: ["SPY"], dimming: true });
    expect(liveQuoteMovesSince("2026-11-04T13:30:00.000Z")).toEqual({
      all: false,
      tickers: ["SPY", "VEA"],
      fx: ["USD_CLP", "EUR_USD"],
      dimming: true,
    });
    expect(liveQuoteMovesSince("2026-11-04T13:30:15.000Z")).toBeNull();
  });

  it("reads a stamp from before this process, or none, as everything", () => {
    noteLiveQuotesChanged("2026-11-04T13:30:00.000Z", { tickers: ["SPY"] });
    expect(liveQuoteMovesSince("2026-11-04T12:59:00.000Z")?.all).toBe(true);
    expect(liveQuoteMovesSince(null)?.all).toBe(true);
  });

  it("reads a stamp the log no longer reaches as everything", () => {
    for (let i = 0; i < 501; i++) {
      noteLiveQuotesChanged(new Date(Date.parse("2026-11-04T14:00:00.000Z") + i * 1000).toISOString(), {
        tickers: ["SPY"],
      });
    }
    // The first entry (14:00:00) was dropped: a client that saw only it may have missed nothing,
    // but the log cannot tell.
    expect(liveQuoteMovesSince("2026-11-04T13:59:59.000Z")?.all).toBe(true);
    expect(liveQuoteMovesSince("2026-11-04T14:00:00.000Z")?.all).toBe(false);
  });

  it("passes on an everything-moved entry", () => {
    noteLiveQuotesChanged("2026-11-04T13:30:00.000Z", { all: true });
    expect(liveQuoteMovesSince(BOOT)?.all).toBe(true);
  });
});
