import { describe, expect, it } from "vitest";
import { buildDailyValuationBlock } from "./dailySeriesChart";
import { GROUP_TAB_VAL_TOTAL } from "./groupTabAggregation";
import type { DailySeriesResponse, TimeseriesBlock } from "./types";

const daily: DailySeriesResponse = {
  unit: "clp",
  end_ymd: "2026-07-02",
  baseline: { as_of_date: "2026-06-30", value: 100 },
  points: [
    { as_of_date: "2026-07-01", value: 110, flow: 0, delta: 10, pl: 10, pct: 0.1, market_day: true },
    { as_of_date: "2026-07-02", value: 120, flow: 0, delta: 10, pl: 10, pct: 0.09, market_day: true },
  ],
  accounts: [{ account_id: 7, name: "Card", values: [110, 120] }],
};

const monthly: Pick<TimeseriesBlock, "accounts" | "lines"> = {
  accounts: [
    { account_id: -1, name: "Total", dataKey: GROUP_TAB_VAL_TOTAL, valueSeriesType: "reference" },
    { account_id: 7, name: "Card", dataKey: "7", valueSeriesType: "data" },
  ],
  lines: [
    {
      dataKey: "ref:liabilities_ref_disponible",
      name: "Disponible",
      valueSeriesType: "reference",
      color_rgb: "94,234,212",
    },
  ],
};

describe("buildDailyValuationBlock — reference overlays", () => {
  it("charts overlay values from the payload with the monthly line's metadata", () => {
    const block = buildDailyValuationBlock(
      {
        ...daily,
        reference_lines: [{ dataKey: "ref:liabilities_ref_disponible", values: [900, 950] }],
      },
      monthly
    );
    expect(block?.lines).toEqual([
      {
        dataKey: "ref:liabilities_ref_disponible",
        name: "Disponible",
        valueSeriesType: "reference",
        color_rgb: "94,234,212",
      },
    ]);
    expect(block?.points[0]!["ref:liabilities_ref_disponible"]).toBe(900);
    expect(block?.points[1]!["ref:liabilities_ref_disponible"]).toBe(950);
    // Overlays live in `lines` only — charting them from `accounts` too would draw twice.
    expect((block?.accounts ?? []).some((a) => a.dataKey.startsWith("ref:"))).toBe(false);
  });

  it("skips overlays the monthly block has no metadata for, rather than inventing a label", () => {
    const block = buildDailyValuationBlock(
      { ...daily, reference_lines: [{ dataKey: "ref:unknown", values: [1, 2] }] },
      monthly
    );
    expect(block?.lines ?? []).toEqual([]);
    expect(block?.points[0]!["ref:unknown"]).toBeUndefined();
  });

  it("skips overlays whose values do not align with the points grid", () => {
    const block = buildDailyValuationBlock(
      {
        ...daily,
        reference_lines: [{ dataKey: "ref:liabilities_ref_disponible", values: [900] }],
      },
      monthly
    );
    expect(block?.lines ?? []).toEqual([]);
  });

  it("omits `lines` entirely when the payload carries no overlays", () => {
    const block = buildDailyValuationBlock(daily, monthly);
    expect(block?.lines).toBeUndefined();
    expect(block?.points[0]![GROUP_TAB_VAL_TOTAL]).toBe(110);
  });
});
