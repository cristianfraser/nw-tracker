import { describe, expect, it } from "vitest";
import { servedDailyPerfComboPoints } from "./servedDailyPerfCombo";
import type { DailySeriesAccountLineDto, DailySeriesPointDto } from "./types";

function dayPoint(as_of_date: string, pl: number | null): DailySeriesPointDto {
  return { as_of_date, value: 0, flow: 0, delta: pl, pl, pct: null, market_day: true };
}

function line(account_id: number, pl: (number | null)[]): DailySeriesAccountLineDto {
  return { account_id, name: `acct-${account_id}`, values: pl.map(() => 0), pl };
}

describe("servedDailyPerfComboPoints", () => {
  const series = {
    points: [dayPoint("2026-03-01", 10), dayPoint("2026-03-02", -4)],
    perf_levels: { delta_total: [10, -4], ytd: [160, 156], accumulated: [1060, 1056] },
  };
  const barAccounts = [
    { account_id: 1, bar_data_key: "pl_1" },
    { account_id: 2, bar_data_key: "pl_2" },
  ];

  it("puts each line's pl under its bar key and the server's levels under the combo keys", () => {
    const pts = servedDailyPerfComboPoints({
      series,
      lines: [line(1, [7, -5]), line(2, [3, null])],
      barAccounts,
    });
    expect(pts).toEqual([
      { as_of_date: "2026-03-01", pl_1: 7, pl_2: 3, delta_total: 10, ytd_group: 160, accumulated_earnings: 1060 },
      { as_of_date: "2026-03-02", pl_1: -5, pl_2: 0, delta_total: -4, ytd_group: 156, accumulated_earnings: 1056 },
    ]);
  });

  it("names the keys as the account combos use them", () => {
    const [p] = servedDailyPerfComboPoints({
      series,
      lines: [line(1, [7, -5])],
      barAccounts: [{ account_id: 1, bar_data_key: "nominal_pl" }],
      ytdKey: "ytd_nominal_pl",
      totalKey: "delta_month",
    });
    expect(p).toEqual({ as_of_date: "2026-03-01", nominal_pl: 7, delta_month: 10, ytd_nominal_pl: 160, accumulated_earnings: 1060 });
  });

  it("throws on a series requested without the levels", () => {
    expect(() =>
      servedDailyPerfComboPoints({ series: { points: series.points }, lines: [], barAccounts })
    ).toThrow(/perf_levels/);
  });
});
