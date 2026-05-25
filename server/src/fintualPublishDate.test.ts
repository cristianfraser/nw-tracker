import { describe, expect, it } from "vitest";
import {
  isFintualFundPublishDay,
  isLastDayOfChileHolidayStreak,
  resolveFintualPublishYmd,
} from "./fintualPublishDate.js";
import { isChileHoliday } from "./marketHolidays.js";
import type { ChileWallClock } from "./chileDate.js";

function cl(ymd: string, hour = 19): ChileWallClock {
  return { ymd, hour, minute: 0, monthKey: ymd.slice(0, 7), day: Number(ymd.slice(8, 10)) };
}

describe("fintualPublishDate", () => {
  it("treats last day of a holiday streak as a publish day, not mid-streak", () => {
    expect(isChileHoliday("2026-04-03")).toBe(true);
    expect(isChileHoliday("2026-04-04")).toBe(true);
    expect(isLastDayOfChileHolidayStreak("2026-04-03")).toBe(false);
    expect(isLastDayOfChileHolidayStreak("2026-04-04")).toBe(true);
    expect(isFintualFundPublishDay("2026-04-03")).toBe(false);
    expect(isFintualFundPublishDay("2026-04-04")).toBe(true);
  });

  it("uses today when the series has today's cuota on a business day", () => {
    const publish = resolveFintualPublishYmd(cl("2026-04-17", 19), {
      hasTodayInSeries: true,
      lastDayDate: "2026-04-17",
    });
    expect(publish).toBe("2026-04-17");
  });

  it("after a single holiday publish, Friday evening keeps Thursday as_of", () => {
    const publish = resolveFintualPublishYmd(cl("2026-04-18", 19), {
      hasTodayInSeries: false,
      lastDayDate: "2026-04-17",
    });
    expect(publish).toBe("2026-04-17");
  });

  it("mid-streak holiday evening uses prior publish day, not the holiday", () => {
    const publish = resolveFintualPublishYmd(cl("2026-04-03", 19), {
      hasTodayInSeries: false,
      lastDayDate: "2026-04-02",
    });
    expect(publish).toBe("2026-04-02");
  });

  it("Friday evening prefers forward last_day over today's series (closure end on Sunday)", () => {
    const publish = resolveFintualPublishYmd(cl("2026-05-22", 19), {
      hasTodayInSeries: true,
      lastDayDate: "2026-05-24",
    });
    expect(publish).toBe("2026-05-24");
  });

  it("uses forward last_day for last day of a holiday streak before the streak calendar day", () => {
    const publish = resolveFintualPublishYmd(cl("2026-04-02", 19), {
      hasTodayInSeries: false,
      lastDayDate: "2026-04-04",
    });
    expect(publish).toBe("2026-04-04");
  });
});
