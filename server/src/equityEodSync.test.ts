import { describe, expect, it } from "vitest";
import type { ChileWallClock } from "./chileDate.js";
import {
  CRYPTO_EOD_SYNC_AFTER_HOUR_CHILE,
  CRYPTO_EOD_SYNC_AFTER_MINUTE_CHILE,
  capCryptoEodSeriesToCompletedUtcDay,
  cryptoCompletedUtcYmd,
  cryptoEodChangeLogDates,
  cryptoEodDueUtcYmd,
  describeEquityNyseEodSyncNote,
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

describe("cryptoCompletedUtcYmd", () => {
  it("is yesterday UTC relative to now", () => {
    expect(cryptoCompletedUtcYmd(new Date("2026-06-12T04:01:00Z"))).toBe("2026-06-11");
  });
});

describe("cryptoEodChangeLogDates", () => {
  it("maps due UTC day to that bar and its predecessor", () => {
    expect(cryptoEodChangeLogDates("2026-05-27")).toEqual({
      oldDate: "2026-05-26",
      newDate: "2026-05-27",
    });
  });
});

describe("capCryptoEodSeriesToCompletedUtcDay", () => {
  it("drops in-progress UTC day bars", () => {
    const now = new Date("2026-06-12T04:01:00Z");
    const capped = capCryptoEodSeriesToCompletedUtcDay(
      {
        dates: ["2026-06-10", "2026-06-11", "2026-06-12"],
        closes: [100, 110, 120],
      },
      now
    );
    expect(capped).toEqual({
      dates: ["2026-06-10", "2026-06-11"],
      closes: [100, 110],
    });
  });
});

describe("cryptoEodDueUtcYmd", () => {
  it("at Tue 23:55 Chile due is last completed UTC day (Tuesday)", () => {
    const at2355Utc = utcYmdAtChileWallClock("2026-05-26", 23, 55);
    expect(at2355Utc).toBe("2026-05-27");
    expect(cryptoEodDueUtcYmd(cl("2026-05-26", 23, 55), new Date("2026-05-27T03:55:00Z"))).toBe(
      "2026-05-26"
    );
  });

  it("Wed 00:04 Chile carryover still due Tuesday completed UTC day when missing from DB", () => {
    const now = new Date("2099-06-03T04:04:00Z");
    expect(cryptoEodDueUtcYmd(cl("2099-06-03", 0, 4), now)).toBe("2099-06-02");
  });

  it("12 Jun 00:01 Chile due is 11 Jun UTC, not in-progress 12 Jun", () => {
    const now = new Date("2026-06-12T04:01:00Z");
    expect(cryptoEodDueUtcYmd(cl("2026-06-12", 0, 1), now)).toBe("2026-06-11");
  });

  it("Tue 20:00 Chile is not due when prior window UTC is caught up", () => {
    expect(cryptoEodDueUtcYmd(cl("2026-05-26", 20, 0))).toBeNull();
  });
});

describe("describeEquityNyseEodSyncNote", () => {
  it("describes still-missing due session", () => {
    expect(
      describeEquityNyseEodSyncNote({
        ticker: "SPY",
        rows: 16,
        dueSessionYmd: "2026-06-17",
        yahooLatestDate: "2026-06-16",
        dbLatestDate: "2026-06-16",
        stillMissingDueSession: true,
      })
    ).toBe("SPY: still missing 2026-06-17 (Yahoo 2026-06-16, DB 2026-06-16)");
  });

  it("describes meta close fallback", () => {
    expect(
      describeEquityNyseEodSyncNote({
        ticker: "VEA",
        rows: 16,
        dueSessionYmd: "2026-06-17",
        usedMetaClose: true,
      })
    ).toBe("VEA: chart meta close for 2026-06-17");
  });
});
