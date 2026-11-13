import { describe, expect, it } from "vitest";
import { readCaseFile } from "./caseFile.js";
import {
  addBusinessDaysIso,
  addDaysIso,
  dayWithinWindow,
  cartolaMovementDateIso,
  daysBetweenIso,
  ddMmYyyyFromIso,
  isIsoDate,
  isoDayNumber,
  parseDdMmYyToIso,
  requireIsoDate,
} from "./dates.js";

/** Python's `parse_dd_mm_yy_to_iso` (`ingest/python/statement_values.py`) asserts the same table. */
describe("parseDdMmYyToIso (shared case table)", () => {
  const cases = readCaseFile<{ raw: string; expect: string | null }[]>("ddMmYyToIsoCases.json");
  it.each(cases)("«$raw» → $expect", (c) => {
    expect(parseDdMmYyToIso(c.raw)).toBe(c.expect);
  });
});

/** The Python cartola parsers (`cartola_row_date`) assert the same table. */
describe("cartolaMovementDateIso (shared case table)", () => {
  type YearCase = { desde: string | null; hasta: string | null; day: number; month: number; expect: string | null };
  const cases = readCaseFile<YearCase[]>("cartolaMovementYearCases.json");
  it.each(cases)("$day/$month in $desde..$hasta → $expect", (c) => {
    const resolve = () => cartolaMovementDateIso(c.day, c.month, { desde: c.desde, hasta: c.hasta });
    if (c.expect === null) expect(resolve).toThrow();
    else expect(resolve()).toBe(c.expect);
  });

  it("says which row it could not date", () => {
    expect(() => cartolaMovementDateIso(31, 12, { desde: "2026-01-01", hasta: "2026-01-31" }, "x.xlsx row 12")).toThrow(
      "x.xlsx row 12: cartola movement 31/12 is not a date inside the period 2026-01-01..2026-01-31"
    );
  });
});

describe("day arithmetic (shared case table)", () => {
  const cases = readCaseFile<{ from: string; days: number; to: string }[]>("dayArithmeticCases.json");
  it.each(cases)("$from + $days → $to", (c) => {
    expect(addDaysIso(c.from, c.days)).toBe(c.to);
    expect(daysBetweenIso(c.from, c.to)).toBe(c.days);
    expect(daysBetweenIso(c.to, c.from)).toBe(0 - c.days);
  });

  it("throws on a day that is not one, never a sentinel distance", () => {
    expect(() => daysBetweenIso("", "2026-01-01")).toThrow(/YYYY-MM-DD/);
    expect(() => addDaysIso("2026-02-30", 1)).toThrow(/YYYY-MM-DD/);
    expect(() => addDaysIso("2026-02-01", 0.5)).toThrow(/whole/);
  });
});

describe("ISO days", () => {
  it("accepts only real calendar days", () => {
    expect(isIsoDate("2024-02-29")).toBe(true);
    expect(isIsoDate("2025-02-29")).toBe(false);
    expect(isIsoDate("2025-13-01")).toBe(false);
    expect(isIsoDate("2025-1-01")).toBe(false);
    expect(requireIsoDate("2026-11-07")).toBe("2026-11-07");
  });

  it("prints dd/mm/yyyy from ISO and throws on anything else", () => {
    expect(ddMmYyyyFromIso("2026-09-24")).toBe("24/09/2026");
    expect(() => ddMmYyyyFromIso("24/09/2026")).toThrow(/expected YYYY-MM-DD/);
  });
});

describe("dayWithinWindow", () => {
  const w = { daysBefore: 1, daysAfter: 5 };
  it("includes both ends and nothing outside", () => {
    expect(dayWithinWindow("2026-03-10", "2026-03-09", w)).toBe(true);
    expect(dayWithinWindow("2026-03-10", "2026-03-15", w)).toBe(true);
    expect(dayWithinWindow("2026-03-10", "2026-03-08", w)).toBe(false);
    expect(dayWithinWindow("2026-03-10", "2026-03-16", w)).toBe(false);
  });
  it("throws on a malformed day", () => {
    expect(() => dayWithinWindow("2026-03-10", "10/03/2026", w)).toThrow();
  });
});

describe("addBusinessDaysIso", () => {
  const weekday = (ymd: string) => ![0, 6].includes(new Date(`${ymd}T00:00:00Z`).getUTCDay());
  it("skips what the calendar calls closed", () => {
    // 2026-03-06 is a Friday.
    expect(addBusinessDaysIso("2026-03-06", 1, weekday)).toBe("2026-03-09");
    expect(addBusinessDaysIso("2026-03-06", 0, weekday)).toBe("2026-03-06");
    expect(addBusinessDaysIso("2026-03-06", 5, weekday)).toBe("2026-03-13");
  });
});

describe("remembered parses", () => {
  it("give the same answers on every call, and a bad day still throws after good ones", () => {
    expect(isoDayNumber("2026-03-05")).toBe(Date.parse("2026-03-05T00:00:00Z") / 86_400_000);
    expect(isoDayNumber("2026-03-05")).toBe(isoDayNumber("2026-03-05"));
    expect(isIsoDate("2026-03-05")).toBe(true);
    for (let i = 0; i < 2; i++) {
      expect(() => isoDayNumber("2026-02-30")).toThrow(/YYYY-MM-DD/);
      expect(isIsoDate("2026-02-30")).toBe(false);
      expect(parseDdMmYyToIso("05/03/26")).toBe("2026-03-05");
      expect(parseDdMmYyToIso("31/13/26")).toBeNull();
      expect(parseDdMmYyToIso(" 05/03/2026 ")).toBe("2026-03-05");
    }
  });
});
