import { describe, expect, it } from "vitest";
import { adjacentPeriodRows } from "./periodModalNav";

type Row = { period_month: string; label?: string };
const keyOf = (r: Row) => r.period_month;

const rows: Row[] = [
  { period_month: "2026-05" },
  { period_month: "2026-03" },
  { period_month: "2026-04" },
];

describe("adjacentPeriodRows", () => {
  it("returns the chronologically adjacent rows regardless of input order", () => {
    const { older, newer } = adjacentPeriodRows(rows, "2026-04", keyOf);
    expect(older?.period_month).toBe("2026-03");
    expect(newer?.period_month).toBe("2026-05");
  });

  it("skips gaps in the period sequence (moves through existing rows only)", () => {
    const gapped: Row[] = [{ period_month: "2026-06" }, { period_month: "2026-01" }];
    const { older, newer } = adjacentPeriodRows(gapped, "2026-06", keyOf);
    expect(older?.period_month).toBe("2026-01");
    expect(newer).toBeNull();
  });

  it("disables at the boundaries", () => {
    expect(adjacentPeriodRows(rows, "2026-05", keyOf).newer).toBeNull();
    expect(adjacentPeriodRows(rows, "2026-05", keyOf).older?.period_month).toBe("2026-04");
    expect(adjacentPeriodRows(rows, "2026-03", keyOf).older).toBeNull();
    expect(adjacentPeriodRows(rows, "2026-03", keyOf).newer?.period_month).toBe("2026-04");
  });

  it("returns no neighbors for a missing or null key", () => {
    expect(adjacentPeriodRows(rows, "2025-12", keyOf)).toEqual({ older: null, newer: null });
    expect(adjacentPeriodRows(rows, null, keyOf)).toEqual({ older: null, newer: null });
  });

  it("returns no neighbors for a single-row set", () => {
    expect(adjacentPeriodRows([{ period_month: "2026-05" }], "2026-05", keyOf)).toEqual({
      older: null,
      newer: null,
    });
  });

  it("handles year-bucket keys (YYYY-12 rollups)", () => {
    const years: Row[] = [
      { period_month: "2024-12" },
      { period_month: "2026-12" },
      { period_month: "2025-12" },
    ];
    const { older, newer } = adjacentPeriodRows(years, "2025-12", keyOf);
    expect(older?.period_month).toBe("2024-12");
    expect(newer?.period_month).toBe("2026-12");
  });

  it("does not mutate the input array", () => {
    const input = [...rows];
    adjacentPeriodRows(input, "2026-04", keyOf);
    expect(input.map(keyOf)).toEqual(["2026-05", "2026-03", "2026-04"]);
  });
});
