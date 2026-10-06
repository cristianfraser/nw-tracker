import { describe, expect, it } from "vitest";
import { afpDisplayDayForOfficialDay, buildAfpDisplaySeries } from "./afpDisplayFrame.js";

// 2026-09-18 (Fiestas Patrias) is a Chile holiday; 2026-09-17 is a business day.
describe("afp display frame", () => {
  it("shows an official business day's value `lag` Chile business days later", () => {
    expect(afpDisplayDayForOfficialDay("2026-09-24", 0)).toBe("2026-09-24");
    expect(afpDisplayDayForOfficialDay("2026-09-24", 1)).toBe("2026-09-25");
    expect(afpDisplayDayForOfficialDay("2026-09-24", 2)).toBe("2026-09-28");
    expect(afpDisplayDayForOfficialDay("2026-09-17", 2)).toBe("2026-09-22");
    expect(() => afpDisplayDayForOfficialDay("2026-09-19", 1)).toThrow(/not a Chile business day/);
  });

  it("carries each value over every calendar day until the next one shows", () => {
    const official = [
      { day: "2026-09-16", unit_value_clp: 100 },
      { day: "2026-09-17", unit_value_clp: 101 },
      { day: "2026-09-18", unit_value_clp: 101 },
      { day: "2026-09-19", unit_value_clp: 101 },
      { day: "2026-09-20", unit_value_clp: 101 },
      { day: "2026-09-21", unit_value_clp: 102 },
    ];
    // Lag 2: 09-16 shows from 09-21 (09-18 is a holiday, then the weekend), as the app did.
    expect(buildAfpDisplaySeries(official, 2, "2026-09-23").map((r) => [r.day, r.unit_value_clp, r.official_day])).toEqual([
      ["2026-09-21", 100, "2026-09-16"],
      ["2026-09-22", 101, "2026-09-17"],
      ["2026-09-23", 102, "2026-09-21"],
    ]);
    // Lag 1: each value shows the next business day and is carried over the long weekend.
    expect(buildAfpDisplaySeries(official, 1, "2026-09-22").map((r) => [r.day, r.unit_value_clp])).toEqual([
      ["2026-09-17", 100],
      ["2026-09-18", 100],
      ["2026-09-19", 100],
      ["2026-09-20", 100],
      ["2026-09-21", 101],
      ["2026-09-22", 102],
    ]);
  });
});
