import { describe, expect, it } from "vitest";
import type { ChileWallClock } from "./chileDate.js";
import {
  CRYPTO_EOD_SYNC_AFTER_HOUR_CHILE,
  CRYPTO_EOD_SYNC_AFTER_MINUTE_CHILE,
  cryptoEodChangeLogDates,
  cryptoEodDueUtcYmd,
  equityEodNyseSyncDue,
  isCryptoEodSyncWindow,
  utcYmdAtChileWallClock,
} from "./equityEodSync.js";

function cl(ymd: string, hour: number, minute = 0): ChileWallClock {
  const [ys, ms, ds] = ymd.split("-");
  const year = Number(ys);
  const month = Number(ms);
  const day = Number(ds);
  return { ymd, year, month, day, hour, minute, monthKey: ymd.slice(0, 7) };
}

describe("equityEodNyseSyncDue", () => {
  it("is null on US holidays (Memorial Day — crypto may sync, NYSE bar not due)", () => {
    const memorialEveningNy = new Date("2026-05-25T22:00:00-04:00");
    expect(equityEodNyseSyncDue(memorialEveningNy)).toBeNull();
  });

  it("is the NY session after 16:05 ET on trading days", () => {
    const tueEveningNy = new Date("2026-05-26T22:00:00-04:00");
    expect(equityEodNyseSyncDue(tueEveningNy)).toBe("2026-05-26");
  });

  it("is null before 16:05 ET on trading days", () => {
    const tueMorningNy = new Date("2026-05-26T10:00:00-04:00");
    expect(equityEodNyseSyncDue(tueMorningNy)).toBeNull();
  });
});

describe("isCryptoEodSyncWindow", () => {
  it("opens at 23:55 Chile", () => {
    expect(isCryptoEodSyncWindow(cl("2026-05-26", 23, 54))).toBe(false);
    expect(isCryptoEodSyncWindow(cl("2026-05-26", 23, 55))).toBe(true);
    expect(isCryptoEodSyncWindow(cl("2026-05-26", 23, CRYPTO_EOD_SYNC_AFTER_MINUTE_CHILE))).toBe(
      true
    );
    expect(isCryptoEodSyncWindow(cl("2026-05-27", 0, 0))).toBe(false);
  });

  it("uses configured hour constant", () => {
    expect(CRYPTO_EOD_SYNC_AFTER_HOUR_CHILE).toBe(23);
    expect(CRYPTO_EOD_SYNC_AFTER_MINUTE_CHILE).toBe(55);
  });
});

describe("cryptoEodChangeLogDates", () => {
  it("maps evening-window due UTC day to prior bar and its predecessor", () => {
    expect(cryptoEodChangeLogDates("2026-05-28")).toEqual({
      oldDate: "2026-05-26",
      newDate: "2026-05-27",
    });
  });

  it("maps carryover due UTC day to that bar and its predecessor", () => {
    expect(cryptoEodChangeLogDates("2026-05-27", { inSyncWindow: false })).toEqual({
      oldDate: "2026-05-26",
      newDate: "2026-05-27",
    });
  });
});

describe("cryptoEodDueUtcYmd", () => {
  it("at Tue 23:55 Chile due is UTC Wednesday", () => {
    const due = utcYmdAtChileWallClock("2026-05-26", 23, 55);
    expect(due).toBe("2026-05-27");
    expect(cryptoEodDueUtcYmd(cl("2026-05-26", 23, 55), new Date("2026-05-27T03:55:00Z"))).toBe(
      "2026-05-27"
    );
  });

  it("Wed 00:04 Chile carryover still due Tuesday window UTC day", () => {
    const now = new Date("2026-05-27T04:04:00Z");
    expect(cryptoEodDueUtcYmd(cl("2026-05-27", 0, 4), now)).toBe("2026-05-27");
  });

  it("Tue 20:00 Chile is not due when prior window UTC is caught up", () => {
    expect(cryptoEodDueUtcYmd(cl("2026-05-26", 20, 0))).toBeNull();
  });
});
