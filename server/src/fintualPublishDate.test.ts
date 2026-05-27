import { describe, expect, it } from "vitest";
import {
  fintualPublishLagsPollCalendarDay,
  isFintualFundPublishDay,
  isLastDayOfChileHolidayStreak,
  isLastDayOfChileNonBusinessBlock,
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
    // Fri–Sat holidays, then Sunday — poll/stale on last non-business day (Sunday).
    expect(isFintualFundPublishDay("2026-04-04")).toBe(false);
    expect(isFintualFundPublishDay("2026-04-05")).toBe(true);
  });

  it("non-business block ends on Monday when Monday is a Chile holiday", () => {
    expect(isChileHoliday("2026-10-12")).toBe(true);
    expect(isLastDayOfChileNonBusinessBlock("2026-10-10")).toBe(false); // Sat
    expect(isLastDayOfChileNonBusinessBlock("2026-10-11")).toBe(false); // Sun
    expect(isLastDayOfChileNonBusinessBlock("2026-10-12")).toBe(true); // Mon holiday
    expect(isFintualFundPublishDay("2026-10-12")).toBe(true);
  });

  it("non-business block ends on Sunday when Monday is a business day", () => {
    expect(isLastDayOfChileNonBusinessBlock("2026-05-23")).toBe(false); // Sat
    expect(isLastDayOfChileNonBusinessBlock("2026-05-24")).toBe(true); // Sun → Mon 2026-05-25 business
    expect(isFintualFundPublishDay("2026-05-24")).toBe(true);
    expect(isLastDayOfChileNonBusinessBlock("2026-06-06")).toBe(false); // Sat
    expect(isLastDayOfChileNonBusinessBlock("2026-06-07")).toBe(true); // Sun → Mon business
  });

  it("publish lags poll calendar day on business evenings only", () => {
    expect(fintualPublishLagsPollCalendarDay(cl("2026-05-25", 19), "2026-05-24")).toBe(true);
    expect(fintualPublishLagsPollCalendarDay(cl("2026-05-25", 19), "2026-05-25")).toBe(false);
    expect(fintualPublishLagsPollCalendarDay(cl("2026-05-25", 17), "2026-05-24")).toBe(false);
    expect(fintualPublishLagsPollCalendarDay(cl("2026-05-24", 19), "2026-05-24")).toBe(false);
  });

  it("solo mid-week Chile holiday is the block end that evening", () => {
    expect(isChileHoliday("2026-05-21")).toBe(true);
    expect(isLastDayOfChileNonBusinessBlock("2026-05-21")).toBe(true);
    expect(isFintualFundPublishDay("2026-05-21")).toBe(true);
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
