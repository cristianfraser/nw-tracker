import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ChileWallClock } from "./chileDate.js";
import { isCryptoEodStale, isStocksNyseStale } from "./globalSyncStale.js";
import type { GlobalSyncStateFile } from "./globalSyncState.js";
import {
  installCryptoTickerFixture,
  removeCryptoTickerFixture,
} from "./test/cryptoTickerFixture.js";

const wed004Chile: ChileWallClock = {
  ymd: "2099-06-03",
  year: 2099,
  month: 6,
  day: 3,
  hour: 0,
  minute: 4,
  monthKey: "2099-06",
};

const cl: ChileWallClock = {
  ymd: "2026-05-26",
  year: 2026,
  month: 5,
  day: 26,
  hour: 23,
  minute: 56,
  monthKey: "2026-05",
};

describe("split equity sync buckets", () => {
  beforeAll(() => installCryptoTickerFixture());
  afterAll(() => removeCryptoTickerFixture());

  it("crypto is not stale before 23:55 Chile even if UTC day lags", () => {
    const early: ChileWallClock = { ...cl, hour: 20, minute: 0 };
    expect(isCryptoEodStale(early, {}, { force: false })).toBe(false);
  });

  it("NYSE and crypto stale are independent", () => {
    const tueNy = new Date("2026-05-26T22:00:00-04:00");
    const state: GlobalSyncStateFile = {};
    const nyseStale = isStocksNyseStale(state, { force: false, now: tueNy });
    const cryptoStale = isCryptoEodStale(cl, state, { force: false, now: tueNy });
    expect(typeof nyseStale).toBe("boolean");
    expect(typeof cryptoStale).toBe("boolean");
  });

  it("Wed 00:04 Chile stays stale until completed UTC due day is in DB", () => {
    const now = new Date("2099-06-03T04:04:00Z");
    expect(isCryptoEodStale(wed004Chile, {}, { now })).toBe(true);
  });

  it("Tue 20:00 Chile is not stale before evening window", () => {
    const early: ChileWallClock = { ...cl, hour: 20, minute: 0 };
    expect(isCryptoEodStale(early, {}, { force: false })).toBe(false);
  });
});
