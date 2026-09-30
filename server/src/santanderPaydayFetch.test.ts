import { describe, expect, it } from "vitest";
import { isLastChileBusinessDayOfMonth, santanderPaydayFetchDecision, type PaydayFetchInputs } from "./santanderPaydayFetch.js";

/** Chile is UTC−3 from 2026-09-06 to 2027-04: 09:30 Chile = 12:30Z. */
function inputs(nowIso: string, over: Partial<PaydayFetchInputs> = {}): PaydayFetchInputs {
  return {
    now: new Date(nowIso),
    lastPaydayAttemptYmd: null,
    lastSuccessfulFetchAt: null,
    lastBankAttemptAt: null,
    loginLatched: false,
    ...over,
  };
}

describe("isLastChileBusinessDayOfMonth", () => {
  it("is the calendar last day when that is a business day", () => {
    expect(isLastChileBusinessDayOfMonth("2026-09-30")).toBe(true);
    expect(isLastChileBusinessDayOfMonth("2026-09-29")).toBe(false);
  });

  it("moves back over a month-end weekend", () => {
    // 2026-10-31 is a Saturday.
    expect(isLastChileBusinessDayOfMonth("2026-10-30")).toBe(true);
    expect(isLastChileBusinessDayOfMonth("2026-10-31")).toBe(false);
  });

  it("moves back over a month-end holiday", () => {
    // 2026-12-31 is a Thursday; December 25 is the listed holiday, so the 31st still counts.
    expect(isLastChileBusinessDayOfMonth("2026-12-31")).toBe(true);
  });
});

describe("santanderPaydayFetchDecision", () => {
  it("is due from 09:00 on payday", () => {
    expect(santanderPaydayFetchDecision(inputs("2026-09-30T12:30:00Z")).due).toBe(true);
  });

  it("waits until 09:00", () => {
    expect(santanderPaydayFetchDecision(inputs("2026-09-30T11:30:00Z")).due).toBe(false);
  });

  it("is not due on other days", () => {
    expect(santanderPaydayFetchDecision(inputs("2026-09-29T12:30:00Z")).due).toBe(false);
  });

  it("tries once per payday", () => {
    const d = santanderPaydayFetchDecision(inputs("2026-09-30T13:30:00Z", { lastPaydayAttemptYmd: "2026-09-30" }));
    expect(d.due).toBe(false);
  });

  it("counts a fetch that already succeeded this payday morning", () => {
    const fetchedAfterNine = inputs("2026-09-30T13:30:00Z", { lastSuccessfulFetchAt: new Date("2026-09-30T12:31:00Z") });
    expect(santanderPaydayFetchDecision(fetchedAfterNine).due).toBe(false);
    // Last night's run fetched before any salary could land.
    const fetchedLastNight = inputs("2026-09-30T12:30:00Z", { lastSuccessfulFetchAt: new Date("2026-09-30T01:05:00Z") });
    expect(santanderPaydayFetchDecision(fetchedLastNight).due).toBe(true);
  });

  it("respects the login latch and the gap after the last bank attempt", () => {
    expect(santanderPaydayFetchDecision(inputs("2026-09-30T12:30:00Z", { loginLatched: true })).due).toBe(false);
    const recent = inputs("2026-09-30T12:30:00Z", { lastBankAttemptAt: new Date("2026-09-30T12:10:00Z") });
    expect(santanderPaydayFetchDecision(recent).due).toBe(false);
  });
});
