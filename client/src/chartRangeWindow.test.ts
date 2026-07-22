import { describe, expect, it } from "vitest";
import { rangeWindowStartYmd, windowMonthRows } from "./chartRangeWindow";

const TODAY = "2026-07-01";

type Row = { m: string; v: number | null };
const win = (rows: Row[], range: Parameters<typeof rangeWindowStartYmd>[0]) =>
  windowMonthRows(
    rows,
    range,
    (r) => r.m,
    (r) => r.v != null,
    (m) => ({ m, v: null }),
    TODAY
  );

describe("rangeWindowStartYmd", () => {
  it("keeps a 20% empty lead when the range reaches past the data (5y range, 3y of data ⇒ show 4y)", () => {
    // first data 3y back; lead = first − 1y (20% of 5y) sits inside the 5y cutoff.
    expect(rangeWindowStartYmd("5y", "2023-07-01", TODAY)).toBe("2022-07-01");
  });

  it("clamps the lead to the range cutoff (5y range, 4.5y of data ⇒ show the full 5y)", () => {
    // first − 1y would predate the cutoff, so the window stops at the 5y cutoff (0.5y empty).
    expect(rangeWindowStartYmd("5y", "2022-01-01", TODAY)).toBe("2021-06-30");
  });

  it("starts flush at the data for total (no truncation ⇒ no gap)", () => {
    expect(rangeWindowStartYmd("total", "2024-11-27", TODAY)).toBe("2024-11-27");
  });

  it("returns the plain cutoff when the data is older than the range (90d)", () => {
    expect(rangeWindowStartYmd("90d", "2020-01-01", TODAY)).toBe("2026-04-02");
  });

  it("falls back to the cutoff when there is no data to anchor on", () => {
    expect(rangeWindowStartYmd("1y", null, TODAY)).toBe("2025-06-30");
  });

  it("returns null (no clip) for total with no data", () => {
    expect(rangeWindowStartYmd("total", null, TODAY)).toBeNull();
  });
});

describe("windowMonthRows", () => {
  const data: Row[] = [
    { m: "2025-01", v: 10 },
    { m: "2025-02", v: 20 },
    { m: "2025-03", v: 30 },
  ];

  it("pads empty leading months back to the window start (5y range, ~2mo of data)", () => {
    const out = win(data, "5y");
    // Window start month is 2024-01, so 12 empty months precede the first data month.
    expect(out).toHaveLength(15);
    expect(out[0]).toEqual({ m: "2024-01", v: null });
    expect(out[11]).toEqual({ m: "2024-12", v: null });
    expect(out[12]).toEqual({ m: "2025-01", v: 10 });
  });

  it("clips older data to the range cutoff with no lead when data fills the range (90d)", () => {
    // Dense monthly rows around the cutoff (the real CC series has a row every month).
    const rows: Row[] = [
      { m: "2025-01", v: 1 },
      { m: "2026-03", v: 3 },
      { m: "2026-04", v: 4 },
      { m: "2026-05", v: 5 },
      { m: "2026-06", v: 6 },
    ];
    const out = win(rows, "90d");
    // 90d cutoff month is 2026-04; older months clip off and no empty lead is added.
    expect(out).toEqual([
      { m: "2026-04", v: 4 },
      { m: "2026-05", v: 5 },
      { m: "2026-06", v: 6 },
    ]);
  });

  it("starts flush at first data for total (no lead, no clip)", () => {
    expect(win(data, "total")).toEqual(data);
  });

  it("keeps the projected right edge untouched", () => {
    const rows: Row[] = [...data, { m: "2027-12", v: 0 }];
    const out = win(rows, "5y");
    expect(out[out.length - 1]).toEqual({ m: "2027-12", v: 0 });
  });
});
