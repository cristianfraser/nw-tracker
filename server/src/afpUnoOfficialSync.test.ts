import { describe, expect, it } from "vitest";
import type { ChileWallClock } from "./chileDate.js";
import { afpUnoExpectedOfficialDay, afpUnoNextDue, isAfpUnoOfficialStale } from "./afpUnoOfficialSync.js";

function at(ymd: string, hour: number): ChileWallClock {
  const [y, m, d] = ymd.split("-").map(Number) as [number, number, number];
  return { ymd, year: y, month: m, day: d, hour, minute: 0 } as ChileWallClock;
}

// 2026-10-02 is a Friday; 10-03/04 the weekend; 10-05 → 10-09 Monday → Friday.
describe("afp_uno official schedule (value of D due at 19:00 on the next business day)", () => {
  it("expects Friday's value from Monday 19:00, and Thursday's before it", () => {
    expect(afpUnoExpectedOfficialDay(at("2026-10-05", 18))).toBe("2026-10-01");
    expect(afpUnoExpectedOfficialDay(at("2026-10-05", 19))).toBe("2026-10-02");
    expect(afpUnoExpectedOfficialDay(at("2026-10-03", 12))).toBe("2026-10-01");
    expect(afpUnoExpectedOfficialDay(at("2026-10-06", 23))).toBe("2026-10-05");
  });

  it("is stale only once the due value is missing", () => {
    expect(isAfpUnoOfficialStale(at("2026-10-05", 18), "2026-10-01")).toBe(false);
    expect(isAfpUnoOfficialStale(at("2026-10-05", 19), "2026-10-01")).toBe(true);
    expect(isAfpUnoOfficialStale(at("2026-10-05", 19), "2026-10-04")).toBe(false);
    expect(isAfpUnoOfficialStale(at("2026-10-05", 19), null)).toBe(true);
  });

  it("wakes at the next business day's 19:00 whose due value is not stored", () => {
    expect(afpUnoNextDue(at("2026-10-05", 10), "2026-10-01")).toEqual({ ymd: "2026-10-05", hour: 19 });
    expect(afpUnoNextDue(at("2026-10-05", 20), "2026-10-02")).toEqual({ ymd: "2026-10-06", hour: 19 });
    // Saturday with Friday's value already stored (the weekend carry printed on 10-04): Tuesday's wake.
    expect(afpUnoNextDue(at("2026-10-03", 12), "2026-10-04")).toEqual({ ymd: "2026-10-06", hour: 19 });
  });
});
