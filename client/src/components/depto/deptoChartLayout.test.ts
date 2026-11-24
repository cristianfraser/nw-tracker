import { describe, expect, it } from "vitest";
import { monthTicks, monthsBetween, spreadLabels, stepPoints } from "./deptoChartLayout";

describe("depto chart layout", () => {
  it("phases month ticks on January and labels the first month with its year", () => {
    const months = monthsBetween("2024-05", "2025-08");
    // 12 px a month: a 6-month stride is the first with ticks 56 px apart; May is 2 months
    // (24 px) before July, too close, so the first tick is July.
    expect(monthTicks(months, 12, 56).map((t) => [t.month, t.withYear])).toEqual([
      ["2024-07", true],
      ["2025-01", true],
      ["2025-07", false],
    ]);
    // 20 px a month: a 3-month stride; April 2024 is on it and carries its year.
    expect(monthTicks(monthsBetween("2024-04", "2025-01"), 20, 56).map((t) => [t.month, t.withYear])).toEqual([
      ["2024-04", true],
      ["2024-07", false],
      ["2024-10", false],
      ["2025-01", true],
    ]);
  });

  it("leaves out an off-phase first month with no room before the next tick", () => {
    const ticks = monthTicks(monthsBetween("2024-06", "2025-02"), 10, 56);
    expect(ticks.map((t) => [t.month, t.withYear])).toEqual([
      ["2024-07", true],
      ["2025-01", true],
    ]);
  });

  it("pushes end labels apart and keeps them inside the box, each at its own index", () => {
    const out = spreadLabels(
      [
        { key: "a", y: 50 },
        { key: "b", y: 52 },
        { key: "c", y: 98 },
      ],
      11,
      0,
      100
    );
    expect(out.map((l) => [l.key, l.at])).toEqual([
      ["a", 50],
      ["b", 61],
      ["c", 98],
    ]);
    const bottom = spreadLabels(
      [
        { key: "x", y: 99 },
        { key: "y", y: 100 },
      ],
      11,
      0,
      100
    );
    expect(bottom.map((l) => l.at)).toEqual([89, 100]);
  });

  it("draws steps horizontally first, then the drop", () => {
    expect(
      stepPoints([
        [0, 10],
        [5, 4],
      ])
    ).toEqual([
      [0, 10],
      [5, 10],
      [5, 4],
    ]);
  });
});
