import { describe, expect, it } from "vitest";
import { densifyRecordsByCalendarPeriod } from "./chartDensifyTimeSeries";

describe("densifyRecordsByCalendarPeriod", () => {
  it("extends monthly buckets through extendThroughYmd", () => {
    const out = densifyRecordsByCalendarPeriod(
      [{ as_of_date: "2026-05-31", cartola: 100, manual: 0, total: 100 }],
      {
        granularity: "month",
        fillMissing: { zeroKeys: ["cartola", "manual", "total"] },
        extendThroughYmd: "2026-06-22",
      }
    );
    expect(out.map((r) => r.as_of_date)).toEqual(["2026-05-31", "2026-06-30"]);
    expect(out[1]).toMatchObject({ cartola: 0, manual: 0, total: 0 });
  });

  it("extends yearly buckets through extendThroughYmd", () => {
    const out = densifyRecordsByCalendarPeriod(
      [{ as_of_date: "2025-12-31", cartola: 50, manual: 0, total: 50 }],
      {
        granularity: "year",
        fillMissing: { zeroKeys: ["cartola", "manual", "total"] },
        extendThroughYmd: "2026-06-22",
      }
    );
    expect(out.map((r) => r.as_of_date)).toEqual(["2025-12-31", "2026-12-31"]);
    expect(out[1]).toMatchObject({ cartola: 0, manual: 0, total: 0 });
  });
});
