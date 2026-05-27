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
});
