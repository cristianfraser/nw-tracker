import { describe, expect, it } from "vitest";
import {
  carryForwardTrailingPendingRows,
  densifyRecordsByCalendarPeriod,
} from "./chartDensifyTimeSeries";

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

describe("carryForwardTrailingPendingRows", () => {
  it("carries the last real row into the day-turn synthetic bucket", () => {
    const dense = densifyRecordsByCalendarPeriod(
      [
        { as_of_date: "2026-08-09", a: 5, b: null },
        { as_of_date: "2026-08-10", a: 6, b: null },
      ],
      { granularity: "day", fillMissing: "null_all", extendThroughYmd: "2026-08-11" }
    );
    const out = carryForwardTrailingPendingRows(dense, "2026-08-10");
    expect(out[out.length - 1]).toMatchObject({ as_of_date: "2026-08-11", a: 6, b: null });
  });

  it("carries a multi-day stale tail flat", () => {
    const dense = densifyRecordsByCalendarPeriod(
      [{ as_of_date: "2026-08-08", a: 4 }],
      { granularity: "day", fillMissing: "null_all", extendThroughYmd: "2026-08-11" }
    );
    const out = carryForwardTrailingPendingRows(dense, "2026-08-08");
    expect(out.map((r) => r.a)).toEqual([4, 4, 4, 4]);
  });

  it("carries the month-turn synthetic bucket at month granularity", () => {
    const dense = densifyRecordsByCalendarPeriod(
      [
        { as_of_date: "2026-07-31", a: 10 },
        { as_of_date: "2026-08-10", a: 11 },
      ],
      { granularity: "month", fillMissing: "null_all", extendThroughYmd: "2026-09-01" }
    );
    const out = carryForwardTrailingPendingRows(dense, "2026-08-10");
    expect(out[out.length - 1]).toMatchObject({ as_of_date: "2026-09-30", a: 11 });
  });

  it("does not resurrect series that ended in a kept zero or null at the last real row", () => {
    const dense = densifyRecordsByCalendarPeriod(
      [
        { as_of_date: "2026-08-09", alive: 5, sold: 900, gone: 3 },
        { as_of_date: "2026-08-10", alive: 6, sold: 0, gone: null },
      ],
      { granularity: "day", fillMissing: "null_all", extendThroughYmd: "2026-08-11" }
    );
    const out = carryForwardTrailingPendingRows(dense, "2026-08-10");
    expect(out[out.length - 1]).toMatchObject({ alive: 6, sold: null, gone: null });
  });

  it("leaves mid-history gaps untouched", () => {
    const dense = densifyRecordsByCalendarPeriod(
      [
        { as_of_date: "2026-08-07", a: 1 },
        { as_of_date: "2026-08-10", a: 2 },
      ],
      { granularity: "day", fillMissing: "null_all", extendThroughYmd: "2026-08-10" }
    );
    const out = carryForwardTrailingPendingRows(dense, "2026-08-10");
    expect(out.map((r) => r.a)).toEqual([1, null, null, 2]);
  });
});
