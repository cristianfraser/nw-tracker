import { describe, expect, it } from "vitest";
import {
  applyMultiSeriesTrailingZeroTailClip,
  groupValTotalSourceKeysForTailClip,
} from "./AppLineChart";

describe("groupValTotalSourceKeysForTailClip", () => {
  it("returns undefined for portfolio account id lines (server consolidated total)", () => {
    const keys = groupValTotalSourceKeysForTailClip([
      { dataKey: "__group_val_total", valueSeriesType: "data" },
      { dataKey: "78", valueSeriesType: "data" },
      { dataKey: "46", valueSeriesType: "data" },
    ]);
    expect(keys).toBeUndefined();
  });

  it("returns undefined for nav-grouped portfolio bucket lines", () => {
    const keys = groupValTotalSourceKeysForTailClip([
      { dataKey: "__group_val_total", valueSeriesType: "data" },
      { dataKey: "nav_retirement_afp_afc", valueSeriesType: "data" },
      { dataKey: "nav_retirement_apv", valueSeriesType: "data" },
    ]);
    expect(keys).toBeUndefined();
  });

  it("returns synthetic bucket keys for liabilities-style blocks", () => {
    const keys = groupValTotalSourceKeysForTailClip([
      { dataKey: "__group_val_total", valueSeriesType: "data" },
      { dataKey: "liab_santander", valueSeriesType: "data" },
      { dataKey: "liab_bci", valueSeriesType: "data" },
    ]);
    expect(keys).toEqual(["liab_santander", "liab_bci"]);
  });
});

describe("applyMultiSeriesTrailingZeroTailClip consolidated total", () => {
  it("preserves server __group_val_total when groupValTotalSourceKeys is omitted", () => {
    const points = [
      {
        as_of_date: "2026-05-31",
        __group_val_total: 95_680_506,
        "78": 29_408_136,
        "46": 63_875_141,
      },
    ];
    const { points: out } = applyMultiSeriesTrailingZeroTailClip(points, {
      series: [
        { dataKey: "78", type: "data" },
        { dataKey: "46", type: "data" },
      ],
    });
    expect(out[0]!.__group_val_total).toBe(95_680_506);
  });

  it("recomputes __group_val_total from synthetic bucket lines when configured", () => {
    const points = [
      {
        as_of_date: "2025-12-31",
        __group_val_total: 0,
        liab_santander: 10_836_954,
        liab_bci: 566_338,
      },
    ];
    const { points: out } = applyMultiSeriesTrailingZeroTailClip(points, {
      series: [
        { dataKey: "liab_santander", type: "data" },
        { dataKey: "liab_bci", type: "data" },
      ],
      groupValTotalSourceKeys: ["liab_santander", "liab_bci"],
    });
    expect(out[0]!.__group_val_total).toBe(10_836_954 + 566_338);
  });
});
