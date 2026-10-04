import { describe, expect, it } from "vitest";
import { irrPerPeriod, windowIrr } from "./irr.js";

describe("irrPerPeriod", () => {
  it("one deposit grown 10% over the period is 10%", () => {
    expect(
      irrPerPeriod(
        [
          { ymd: "2025-01-01", amount: -100 },
          { ymd: "2026-01-01", amount: 110 },
        ],
        "2025-01-01",
        365
      )
    ).toBeCloseTo(0.1, 9);
  });

  it("is null when several rates balance the flows", () => {
    // −100, +230, −132: NPV is zero at 10% and at 20%.
    expect(
      irrPerPeriod(
        [
          { ymd: "2025-01-01", amount: -100 },
          { ymd: "2026-01-01", amount: 230 },
          { ymd: "2027-01-01", amount: -132 },
        ],
        "2025-01-01",
        365
      )
    ).toBeNull();
  });

  it("is null without both money in and money out", () => {
    expect(irrPerPeriod([{ ymd: "2025-01-01", amount: -100 }], "2025-01-01", 365)).toBeNull();
  });
});

describe("windowIrr", () => {
  it("a window under a year is shown over the window, not annualized", () => {
    const r = windowIrr(100, "2026-01-01", "2026-01-02", [], 102)!;
    expect(r.annualized).toBe(false);
    expect(r.pct).toBeCloseTo(0.02, 9);
  });

  it("a window of a year or more is annualized", () => {
    const r = windowIrr(100, "2024-01-01", "2026-01-01", [], 121)!;
    expect(r.annualized).toBe(true);
    // 731 days (2024 is a leap year): (1,21)^(365/731) − 1.
    expect(r.pct).toBeCloseTo(Math.pow(1.21, 365 / 731) - 1, 9);
  });

  it("weights money by how long it was in: the $1 loses 10%, then $99 joins and gains 10%", () => {
    // Time-weighted −1%; the money made +$9,89, so its IRR is clearly positive.
    const r = windowIrr(1, "2026-01-01", "2026-03-02", [{ ymd: "2026-01-31", amount: 99 }], 109.89)!;
    expect(r.annualized).toBe(false);
    expect(r.pct).toBeGreaterThan(0.09);
  });

  it("an empty start runs from the first deposit", () => {
    const r = windowIrr(0, "2024-12-31", "2026-01-01", [{ ymd: "2025-01-01", amount: 100 }], 110)!;
    expect(r.annualized).toBe(true);
    expect(r.pct).toBeCloseTo(0.1, 9);
  });
});
