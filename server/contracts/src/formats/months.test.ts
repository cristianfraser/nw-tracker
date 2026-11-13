import { describe, expect, it } from "vitest";
import { readCaseFile } from "./caseFile.js";
import {
  addCalendarMonths,
  expandYearMonthsInclusive,
  isLastCalendarDayOfMonth,
  monthEndUtcYmd,
  monthEndsBetweenInclusive,
  monthFromSpanishName,
  parseYearMonth,
  spanishMonthName,
} from "./months.js";

describe("year-month arithmetic", () => {
  it("adds months across year ends and throws on anything but YYYY-MM", () => {
    expect(addCalendarMonths("2025-12", 1)).toBe("2026-01");
    expect(addCalendarMonths("2026-01", -1)).toBe("2025-12");
    expect(addCalendarMonths("2026-03", -14)).toBe("2025-01");
    expect(() => addCalendarMonths("", 1)).toThrow(/YYYY-MM/);
    expect(() => addCalendarMonths("2026-13", 1)).toThrow(/YYYY-MM/);
  });

  it("parses a plausible year-month or returns null", () => {
    expect(parseYearMonth(" 2026-09 ")).toBe("2026-09");
    expect(parseYearMonth("1989-01")).toBeNull();
    expect(parseYearMonth("2026-9")).toBeNull();
  });

  it("knows month ends", () => {
    expect(monthEndUtcYmd("2024-02")).toBe("2024-02-29");
    expect(() => monthEndUtcYmd("2024-13")).toThrow(/invalid month key/);
    expect(isLastCalendarDayOfMonth("2026-04-30")).toBe(true);
    expect(isLastCalendarDayOfMonth("2026-04-29")).toBe(false);
    expect(expandYearMonthsInclusive("2025-11", "2026-02")).toEqual(["2025-11", "2025-12", "2026-01", "2026-02"]);
    expect(monthEndsBetweenInclusive("2025-12-15", "2026-02-01")).toEqual(["2025-12-31", "2026-01-31", "2026-02-28"]);
  });
});

describe("Spanish month names (shared case table)", () => {
  const cases = readCaseFile<{ raw: string; expect: number | null }[]>("spanishMonthCases.json");
  it.each(cases)("«$raw» → $expect", (c) => {
    expect(monthFromSpanishName(c.raw)).toBe(c.expect);
  });

  it("names every month and back", () => {
    for (let m = 1; m <= 12; m++) expect(monthFromSpanishName(spanishMonthName(m))).toBe(m);
    expect(() => spanishMonthName(13)).toThrow(/no month/);
  });
});

describe("addCalendarMonths arithmetic", () => {
  it("moves months exactly like a UTC date's month, across years and both directions", () => {
    const viaDate = (ym: string, delta: number) => {
      const d = new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)) - 1 + delta, 1));
      return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    };
    for (const ym of ["1999-01", "2015-06", "2024-12", "2026-11", "2100-02"]) {
      for (let delta = -400; delta <= 400; delta += 7) {
        expect(addCalendarMonths(ym, delta)).toBe(viaDate(ym, delta));
      }
    }
    expect(() => addCalendarMonths("2026-1", 1)).toThrow(/YYYY-MM/);
    expect(() => addCalendarMonths("2026-01", 0.5)).toThrow(/whole number/);
  });
});
