import { describe, expect, it } from "vitest";
import type { ChileWallClock } from "./chileDate.js";
import { attachSyncSourceSchedule } from "./syncSourceSchedule.js";

function cl(ymd: string, hour: number, minute = 0): ChileWallClock {
  const [ys, ms, ds] = ymd.split("-");
  return {
    ymd,
    year: Number(ys),
    month: Number(ms),
    day: Number(ds),
    hour,
    minute,
    monthKey: ymd.slice(0, 7),
  };
}

describe("attachSyncSourceSchedule", () => {
  it("crypto next sync is today 23:55 before the window", () => {
    const sched = attachSyncSourceSchedule("crypto_eod", cl("2026-05-26", 20), false, false);
    expect(sched.next_sync_imminent).toBe(false);
    expect(sched.next_sync).toEqual({
      ymd: "2026-05-26",
      hour: 23,
      minute: 55,
      timeZone: "America/Santiago",
    });
  });

  it("marks stale sources as imminent", () => {
    const sched = attachSyncSourceSchedule("stocks_nyse", cl("2026-05-26", 20), true, false);
    expect(sched.next_sync_imminent).toBe(true);
    expect(sched.next_sync).toBeNull();
  });

  it("NYSE holiday is flagged on Memorial Day", () => {
    const sched = attachSyncSourceSchedule("stocks_nyse", cl("2026-05-25", 20), false, false);
    expect(sched.today_day_kind).toBe("holiday");
  });

  it("Santiago next sync is today 17:10 Chile before the window, even on a NYSE holiday", () => {
    const sched = attachSyncSourceSchedule("stocks_santiago", cl("2026-09-07", 15), false, false);
    expect(sched.next_sync_imminent).toBe(false);
    expect(sched.today_day_kind).toBe("open");
    expect(sched.next_sync).toEqual({
      ymd: "2026-09-07",
      hour: 17,
      minute: 10,
      timeZone: "America/Santiago",
    });
  });

  it("Santiago next sync after the window skips Fiestas Patrias and the weekend", () => {
    const sched = attachSyncSourceSchedule("stocks_santiago", cl("2026-09-17", 20), false, false);
    expect(sched.next_sync).toEqual({
      ymd: "2026-09-21",
      hour: 17,
      minute: 10,
      timeZone: "America/Santiago",
    });
  });

  it("Chilean holiday is flagged on 18 de septiembre for the Santiago source", () => {
    const sched = attachSyncSourceSchedule("stocks_santiago", cl("2026-09-18", 12), false, false);
    expect(sched.today_day_kind).toBe("holiday");
    expect(sched.next_sync?.ymd).toBe("2026-09-21");
  });

  it("fx next sync is today 17:05 New York before the day end, on any weekday", () => {
    const sched = attachSyncSourceSchedule("yahoo_fx_usd", cl("2026-09-07", 12), false, false); // US Labor Day
    expect(sched.today_day_kind).toBe("open");
    expect(sched.next_sync).toEqual({ ymd: "2026-09-07", hour: 17, minute: 5, timeZone: "America/New_York" });
  });

  it("fx next sync after the day end is the next weekday, skipping the weekend", () => {
    const fri = attachSyncSourceSchedule("yahoo_fx_usd", cl("2026-09-04", 19), false, false);
    expect(fri.next_sync?.ymd).toBe("2026-09-07");
    const sat = attachSyncSourceSchedule("yahoo_fx_usd", cl("2026-09-05", 12), false, false);
    expect(sat.today_day_kind).toBe("weekend");
    expect(sat.next_sync?.ymd).toBe("2026-09-07");
  });

  it("fintual next sync is tomorrow 18:00 after 18:00 today", () => {
    const sched = attachSyncSourceSchedule("fintual", cl("2026-05-25", 21, 28), false, false);
    expect(sched.next_sync_imminent).toBe(false);
    expect(sched.next_sync).toEqual({
      ymd: "2026-05-26",
      hour: 18,
      minute: 0,
      timeZone: "America/Santiago",
    });
  });

  it("fintual carry-over stale polls immediately before the evening window", () => {
    const sched = attachSyncSourceSchedule("fintual", cl("2026-06-10", 8), true, false);
    expect(sched.next_sync_imminent).toBe(true);
    expect(sched.next_sync).toBeNull();
  });
});
