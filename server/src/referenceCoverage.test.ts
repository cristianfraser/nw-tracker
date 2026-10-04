import { describe, expect, it } from "vitest";
import { buildReferenceCoverage, sumAlignedValues, sumKeysPerRow } from "./referenceCoverage.js";

describe("buildReferenceCoverage", () => {
  const dates = ["2024-03-31", "2024-04-30", "2024-05-31"];

  it("divides each reference by the mortgage, null where there is no mortgage", () => {
    const block = buildReferenceCoverage(dates, [null, 100, 80], [
      { dataKey: "ref:a", name: "A", values: [50, 25, -8] },
      { dataKey: "ref:b", name: "B", name_i18n_key: "x.b", values: [90, 120, null] },
    ])!;
    expect(block.dates).toEqual(dates);
    expect(block.series.map((s) => s.dataKey)).toEqual(["coverage:ref:a", "coverage:ref:b"]);
    expect(block.series[0]!.values).toEqual([null, 0.25, -0.1]);
    expect(block.series[1]!.values).toEqual([null, 1.2, null]);
    expect(block.series[1]!.name_i18n_key).toBe("x.b");
  });

  it("is null when no date has a mortgage", () => {
    expect(buildReferenceCoverage(dates, [null, 0, null], [{ dataKey: "r", name: "R", values: [1, 2, 3] }])).toBeNull();
  });

  it("throws on misaligned inputs", () => {
    expect(() => buildReferenceCoverage(dates, [1, 2], [])).toThrow(/2 mortgage values/);
    expect(() => buildReferenceCoverage(dates, [1, 2, 3], [{ dataKey: "r", name: "R", values: [1] }])).toThrow(
      /r has 1 values/
    );
  });
});

describe("row sums", () => {
  it("sum the given keys, null where none has a number", () => {
    expect(sumKeysPerRow([{ a: 1, b: 2 }, { a: null }, { b: 3 }], ["a", "b"])).toEqual([3, null, 3]);
    expect(sumAlignedValues([[1, null, 2], [3, null, null]], 3)).toEqual([4, null, 2]);
  });
});
