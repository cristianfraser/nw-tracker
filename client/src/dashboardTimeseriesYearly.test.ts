import { describe, expect, it } from "vitest";
import { addCalendarMonths, monthEndUtcYmd } from "./calendarMonth";
import { rollupPerfPointsYearly } from "./dashboardTimeseriesYearly";
import { clipMonthsThenRollup } from "./timeRange";

type Row = Record<string, string | number | null>;

const PL: Record<string, { pl_1?: number; pl_2?: number }> = {
  "2023-03": { pl_1: 100 },
  "2023-12": { pl_1: 10, pl_2: 5 },
  "2024-06": { pl_2: 20 },
};

/** A group P/L monthly block as the server builds it: bars, Σ, running YTD and lifetime level. */
function groupPerfMonths(fromYm: string, toYm: string): Row[] {
  const out: Row[] = [];
  let year = "";
  let ytd = 0;
  let accumulated = 0;
  for (let ym = fromYm; ym <= toYm; ym = addCalendarMonths(ym, 1)) {
    const pl_1 = PL[ym]?.pl_1 ?? 0;
    const pl_2 = PL[ym]?.pl_2 ?? 0;
    const delta_total = pl_1 + pl_2;
    if (ym.slice(0, 4) !== year) {
      year = ym.slice(0, 4);
      ytd = 0;
    }
    ytd += delta_total;
    accumulated += delta_total;
    out.push({
      as_of_date: monthEndUtcYmd(ym),
      pl_1,
      pl_2,
      delta_total,
      ytd_group: ytd,
      accumulated_earnings: accumulated,
    });
  }
  return out;
}

const OPTS = {
  sumKeys: ["pl_1", "pl_2"],
  ytdKey: "ytd_group",
  accumKey: "accumulated_earnings",
  totalKey: "delta_total",
};

describe("rollupPerfPointsYearly (P/L combos, yearly view)", () => {
  const months = groupPerfMonths("2023-01", "2024-12");

  it("sums the bars per year, YTD is the year's total and accumulated the year-end level", () => {
    expect(rollupPerfPointsYearly(months, OPTS)).toEqual([
      {
        as_of_date: "2023-12-31",
        pl_1: 110,
        pl_2: 5,
        delta_total: 115,
        ytd_group: 115,
        accumulated_earnings: 115,
      },
      {
        as_of_date: "2024-12-31",
        pl_1: 0,
        pl_2: 20,
        delta_total: 20,
        ytd_group: 20,
        accumulated_earnings: 135,
      },
    ]);
  });

  it("under a Rango: a partial first year, the accumulated level in the full-history frame", () => {
    // 1y back from 2024-12-15 is 2023-12-15: only December 2023 is inside the range.
    const years = clipMonthsThenRollup(
      months,
      "year",
      "1y",
      (inRange) => rollupPerfPointsYearly(inRange, OPTS),
      "2024-12-15"
    );
    expect(years[0]).toEqual({
      as_of_date: "2023-12-31",
      pl_1: 10,
      pl_2: 5,
      delta_total: 15,
      ytd_group: 15,
      // The monthly chart's own December 2023 level (March's 100 included), not 15.
      accumulated_earnings: 115,
    });
    expect(years[1]).toMatchObject({ delta_total: 20, accumulated_earnings: 135 });
  });

  it("fails fast when the monthly rows do not carry the accumulated level", () => {
    const withoutLevel = months.map((row) => {
      const copy = { ...row };
      delete copy.accumulated_earnings;
      return copy;
    });
    expect(() => rollupPerfPointsYearly(withoutLevel, OPTS)).toThrow(/accumulated_earnings/);
  });
});
