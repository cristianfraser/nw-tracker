import { describe, expect, it } from "vitest";
import { dataKeysWithWindowData, seriesWithWindowData } from "./chartSeriesWindowPresence";

const rows = [
  { as_of_date: "2026-07-01", spy: 100, oilk: null, flat: 0 },
  { as_of_date: "2026-07-02", spy: 110, oilk: null, flat: 0 },
];

describe("dataKeysWithWindowData", () => {
  it("keeps keys with a finite value and drops all-null ones", () => {
    const present = dataKeysWithWindowData(rows, ["spy", "oilk"]);
    expect([...present]).toEqual(["spy"]);
  });

  it("keeps zeros by default (a flat 0 line is visible)", () => {
    expect(dataKeysWithWindowData(rows, ["flat"]).has("flat")).toBe(true);
  });

  it("drops zero-only keys when zeros mean 'no band' (proportional chart)", () => {
    const present = dataKeysWithWindowData(rows, ["spy", "flat"], { treatZeroAsEmpty: true });
    expect([...present]).toEqual(["spy"]);
  });

  it("ignores keys absent from every row and non-numeric cells", () => {
    const odd = [{ as_of_date: "2026-07-01", label: "x" }];
    expect(dataKeysWithWindowData(odd, ["missing", "label"]).size).toBe(0);
  });
});

describe("seriesWithWindowData", () => {
  it("drops a series with no data in the window", () => {
    const kept = seriesWithWindowData([{ dataKey: "spy" }, { dataKey: "oilk" }], rows);
    expect(kept.map((s) => s.dataKey)).toEqual(["spy"]);
  });

  it("keeps a deposit companion alongside its value line", () => {
    const kept = seriesWithWindowData(
      [
        { dataKey: "spy" },
        { dataKey: "spy_dep", depositFor: "spy" },
        { dataKey: "oilk" },
        { dataKey: "oilk_dep", depositFor: "oilk" },
      ],
      rows
    );
    expect(kept.map((s) => s.dataKey)).toEqual(["spy", "spy_dep"]);
  });

  it("drops a deposit companion whose value line is gone, even though aportes carry on", () => {
    // A sold-out account keeps its cumulative aportes forever — the value line decides.
    const soldOut = [
      { as_of_date: "2026-07-01", oilk: null, oilk_dep: 280056 },
      { as_of_date: "2026-07-02", oilk: null, oilk_dep: 280056 },
    ];
    const kept = seriesWithWindowData(
      [{ dataKey: "oilk" }, { dataKey: "oilk_dep", depositFor: "oilk" }],
      soldOut
    );
    expect(kept).toEqual([]);
  });

  it("drops zero-only series when zeros have no geometry (P/L bars)", () => {
    const kept = seriesWithWindowData([{ dataKey: "spy" }, { dataKey: "flat" }], rows, {
      treatZeroAsEmpty: true,
    });
    expect(kept.map((s) => s.dataKey)).toEqual(["spy"]);
  });

  it("preserves the incoming series order", () => {
    const kept = seriesWithWindowData(
      [{ dataKey: "oilk" }, { dataKey: "spy" }, { dataKey: "flat" }],
      rows
    );
    expect(kept.map((s) => s.dataKey)).toEqual(["spy", "flat"]);
  });
});
