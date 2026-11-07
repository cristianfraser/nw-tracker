import { describe, expect, it } from "vitest";
import type { ChileWallClock } from "./chileDate.js";
import { isAfpUnoOfficialStale } from "./afpUnoOfficialSync.js";

function at(ymd: string, hour: number): ChileWallClock {
  const [y, m, d] = ymd.split("-").map(Number) as [number, number, number];
  return { ymd, year: y, month: m, day: d, hour, minute: 0 } as ChileWallClock;
}

// 2026-10-02 is a Friday; 10-03/04 the weekend; 10-05 → 10-09 Monday → Friday.
describe("afp_uno official schedule (value of D due at 18:00 on the next business day)", () => {
  it("is stale only once the due value is missing", () => {
    expect(isAfpUnoOfficialStale(at("2026-10-05", 17), "2026-10-01")).toBe(false);
    expect(isAfpUnoOfficialStale(at("2026-10-05", 18), "2026-10-01")).toBe(true);
    expect(isAfpUnoOfficialStale(at("2026-10-05", 18), "2026-10-04")).toBe(false);
    expect(isAfpUnoOfficialStale(at("2026-10-05", 18), null)).toBe(true);
  });
});
