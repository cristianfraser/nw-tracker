import { describe, expect, it } from "vitest";
import { fxDayDueYmd, fxDayEndInstant, isFxDayOpen, nextWeekdayYmd, priorWeekdayYmd } from "./forexDay.js";

// Three DST combinations exist: Chile summer + NY winter (Nov–Mar), both summer (Sep–Nov,
// Mar–Apr), Chile winter + NY summer (Apr–Sep). The day end is 17:05 New York in each.
describe("fxDayEndInstant", () => {
  it("is 17:05 New York whatever Chile's clock says", () => {
    expect(fxDayEndInstant("2026-09-07").toISOString()).toBe("2026-09-07T21:05:00.000Z"); // EDT, Chile -03 → 18:05 Chile
    expect(fxDayEndInstant("2026-06-05").toISOString()).toBe("2026-06-05T21:05:00.000Z"); // EDT, Chile -04 → 17:05 Chile
    expect(fxDayEndInstant("2026-12-10").toISOString()).toBe("2026-12-10T22:05:00.000Z"); // EST, Chile -03 → 19:05 Chile
  });
});

describe("isFxDayOpen", () => {
  it("floats through a US holiday and a Chilean holiday (weekday before 17:05 NY)", () => {
    expect(isFxDayOpen(new Date("2026-09-07T12:00:00-03:00"))).toBe(true); // Labor Day
    expect(isFxDayOpen(new Date("2026-09-18T12:00:00-03:00"))).toBe(true); // Fiestas Patrias
  });

  it("closes at 17:05 New York in every DST combination", () => {
    expect(isFxDayOpen(new Date("2026-09-07T18:00:00-03:00"))).toBe(true);
    expect(isFxDayOpen(new Date("2026-09-07T18:05:00-03:00"))).toBe(false);
    expect(isFxDayOpen(new Date("2026-06-05T17:00:00-04:00"))).toBe(true);
    expect(isFxDayOpen(new Date("2026-06-05T17:10:00-04:00"))).toBe(false);
    expect(isFxDayOpen(new Date("2026-12-10T19:00:00-03:00"))).toBe(true);
    expect(isFxDayOpen(new Date("2026-12-10T19:10:00-03:00"))).toBe(false);
  });

  it("is closed all weekend, Sunday evening included, and opens at Chile midnight Monday", () => {
    expect(isFxDayOpen(new Date("2026-09-05T12:00:00-03:00"))).toBe(false); // Saturday
    expect(isFxDayOpen(new Date("2026-09-06T21:00:00-03:00"))).toBe(false); // Sunday reopen hours
    expect(isFxDayOpen(new Date("2026-09-07T00:30:00-03:00"))).toBe(true); // Monday 00:30 Chile
  });
});

describe("fxDayDueYmd", () => {
  it("is today once the fx day ended, else the last weekday (carry-over)", () => {
    expect(fxDayDueYmd(new Date("2026-09-07T18:10:00-03:00"))).toBe("2026-09-07");
    expect(fxDayDueYmd(new Date("2026-09-07T12:00:00-03:00"))).toBe("2026-09-04");
    expect(fxDayDueYmd(new Date("2026-09-08T00:30:00-03:00"))).toBe("2026-09-07");
  });

  it("points at Friday all weekend", () => {
    expect(fxDayDueYmd(new Date("2026-09-05T12:00:00-03:00"))).toBe("2026-09-04");
    expect(fxDayDueYmd(new Date("2026-09-06T23:00:00-03:00"))).toBe("2026-09-04");
  });
});

describe("weekday stepping", () => {
  it("skips weekends only — holidays are forex days", () => {
    expect(priorWeekdayYmd("2026-09-07")).toBe("2026-09-04");
    expect(priorWeekdayYmd("2026-09-21")).toBe("2026-09-18"); // Fiestas Patrias Friday still counts
    expect(nextWeekdayYmd("2026-09-04")).toBe("2026-09-07");
    expect(nextWeekdayYmd("2026-09-17")).toBe("2026-09-18");
  });
});
