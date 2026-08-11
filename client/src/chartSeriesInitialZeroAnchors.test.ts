import { describe, expect, it } from "vitest";
import {
  coerceKeptTrailingZeroMonth,
  prependInitialZeroAnchors,
  prependInitialZeroAnchorsOnBlock,
  priorCalendarPeriodEndYmd,
  valuationDataKeysForInitialZeroAnchors,
} from "./chartSeriesInitialZeroAnchors";
import {
  carryForwardTrailingPendingRows,
  densifyRecordsByCalendarPeriod,
} from "./chartDensifyTimeSeries";

describe("priorCalendarPeriodEndYmd", () => {
  it("returns prior month-end", () => {
    expect(priorCalendarPeriodEndYmd("2026-05-31", "month")).toBe("2026-04-30");
  });

  it("returns prior year-end", () => {
    expect(priorCalendarPeriodEndYmd("2026-05-31", "year")).toBe("2025-12-31");
  });
});

describe("prependInitialZeroAnchors", () => {
  it("inserts leading 0 one month before first finite value (single-point LIN/CCJ)", () => {
    const out = prependInitialZeroAnchors(
      [{ as_of_date: "2026-05-31", lin: 1_500_000 }],
      ["lin"],
      { granularity: "month" }
    );
    expect(out).toEqual([
      { as_of_date: "2026-04-30", lin: 0 },
      { as_of_date: "2026-05-31", lin: 1_500_000 },
    ]);
  });

  it("merges anchor into an existing row when the prior month is already present", () => {
    const out = prependInitialZeroAnchors(
      [
        { as_of_date: "2026-04-30", spy: 100 },
        { as_of_date: "2026-05-31", oilk: 800_000 },
      ],
      ["oilk"],
      { granularity: "month" }
    );
    expect(out[0]).toMatchObject({ as_of_date: "2026-04-30", oilk: 0, spy: 100 });
    expect(out[1]).toMatchObject({ as_of_date: "2026-05-31", oilk: 800_000 });
  });

  it("skips class totals and reference overlays", () => {
    const keys = valuationDataKeysForInitialZeroAnchors({
      accounts: [
        { account_id: 1, name: "A", dataKey: "__group_val_total", valueSeriesType: "data" },
        { account_id: 2, name: "B", dataKey: "42", valueSeriesType: "data" },
        { account_id: -1, name: "ref", dataKey: "ref:foo", valueSeriesType: "reference" },
      ],
      lines: [
        { dataKey: "usd_50k", name: "US$50,000", valueSeriesType: "reference" },
        { dataKey: "total_nw", name: "NW", valueSeriesType: "data" },
      ],
      points: [],
    });
    expect(keys).toEqual(["42", "total_nw"]);
  });

  it("does not prepend 0 before USD milestone reference lines", () => {
    const block = {
      accounts: [],
      lines: [
        { dataKey: "total_nw", name: "NW", valueSeriesType: "data" as const },
        { dataKey: "usd_50k", name: "US$50,000", valueSeriesType: "reference" as const },
      ],
      points: [
        { as_of_date: "2017-04-30", total_nw: 0, usd_50k: 32_000_000 },
        { as_of_date: "2017-05-31", total_nw: 1_000_000, usd_50k: 32_500_000 },
      ],
    };
    const out = prependInitialZeroAnchorsOnBlock(block, "month").points;
    expect(out.some((r) => r.usd_50k === 0)).toBe(false);
    expect(out.find((r) => r.as_of_date === "2017-03-31")).toMatchObject({ total_nw: 0 });
  });

  it("backfills USD milestone reference lines on synthetic zero anchors", () => {
    const block = {
      accounts: [],
      lines: [
        { dataKey: "total_nw", name: "NW", valueSeriesType: "data" as const },
        { dataKey: "usd_50k", name: "US$50,000", valueSeriesType: "reference" as const },
      ],
      points: [
        { as_of_date: "2017-04-30", total_nw: 0 },
        { as_of_date: "2017-05-31", total_nw: 1_000_000 },
      ],
      referenceMilestoneByDate: {
        "2017-03-31": { usd_50k: 31_500_000 },
      },
    };
    const anchor = prependInitialZeroAnchorsOnBlock(block, "month").points.find(
      (r) => r.as_of_date === "2017-03-31"
    );
    expect(anchor).toMatchObject({ total_nw: 0, usd_50k: 31_500_000 });
  });
});

describe("coerceKeptTrailingZeroMonth", () => {
  it("turns the first trailing null after last non-zero into 0", () => {
    const out = coerceKeptTrailingZeroMonth(
      [
        { as_of_date: "2026-04-30", oilk: 0 },
        { as_of_date: "2026-05-31", oilk: 900_000 },
        { as_of_date: "2026-06-30", oilk: null },
      ],
      ["oilk"]
    );
    expect(out[2]!.oilk).toBe(0);
  });
});

describe("LineChartPanel point pipeline (anchor → densify → carry → coerce)", () => {
  const run = (raw: { as_of_date: string; oilk: number | null }[], lastRealYmd: string) => {
    const anchored = prependInitialZeroAnchors(raw, ["oilk"], { granularity: "month" });
    const dense = densifyRecordsByCalendarPeriod(anchored, {
      granularity: "month",
      fillMissing: "null_all",
      extendThroughYmd: "2026-06-24",
    });
    const carried = carryForwardTrailingPendingRows(dense, lastRealYmd);
    return coerceKeptTrailingZeroMonth(carried, ["oilk"]);
  };

  it("carries an alive series flat into the pending current bucket", () => {
    // Data ends on a positive value = alive at the last known date (server tail clip ends a
    // sold-out series in a kept 0). The month turned before fresh data loaded: extend flat.
    const points = run([{ as_of_date: "2026-05-31", oilk: 900_000 }], "2026-05-31");
    const oilk = points.map((r) => r.oilk);
    expect(oilk).toContain(0); // leading anchor
    const lastNonNull = [...oilk].reverse().find((v) => v != null);
    expect(lastNonNull).toBe(900_000);
  });

  it("plots [0, x, 0] for a sold-out series (server kept zero) without resurrecting it", () => {
    const points = run(
      [
        { as_of_date: "2026-04-30", oilk: 900_000 },
        { as_of_date: "2026-05-31", oilk: 0 },
      ],
      "2026-05-31"
    );
    const oilk = points.map((r) => r.oilk);
    expect(oilk).toContain(900_000);
    const lastNonNull = [...oilk].reverse().find((v) => v != null);
    expect(lastNonNull).toBe(0);
    // The pending June bucket stays null — the line ends at the kept zero.
    expect(points[points.length - 1]!.oilk).toBeNull();
  });
});
