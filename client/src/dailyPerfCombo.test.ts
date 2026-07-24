import { describe, expect, it } from "vitest";
import { buildDailyPerfComboPoints, cumulativeAnchorsBeforeWindow } from "./dailyPerfCombo";
import type { DailySeriesAccountLineDto, DailySeriesPointDto } from "./types";

function dayPoint(as_of_date: string, pl: number | null): DailySeriesPointDto {
  return { as_of_date, value: 0, flow: 0, delta: pl, pl, pct: null, market_day: true };
}

function line(account_id: number, pl: (number | null)[]): DailySeriesAccountLineDto {
  return { account_id, name: `acct-${account_id}`, values: pl.map(() => 0), pl };
}

/** Monthly series: Jan +100, Feb +50, Mar +30 (ytd resets each year, accum runs for life). */
const MONTHLY = [
  { as_of_date: "2025-12-31", pl_1: 70, delta_total: 70, ytd_group: 700, accumulated_earnings: 900 },
  { as_of_date: "2026-01-31", pl_1: 100, delta_total: 100, ytd_group: 100, accumulated_earnings: 1000 },
  { as_of_date: "2026-02-28", pl_1: 50, delta_total: 50, ytd_group: 150, accumulated_earnings: 1050 },
];

describe("cumulativeAnchorsBeforeWindow", () => {
  it("takes the last month-end strictly before the window", () => {
    expect(cumulativeAnchorsBeforeWindow(MONTHLY, "2026-03-01")).toEqual({
      ytd: 150,
      accumulated: 1050,
    });
  });

  it("drops the YTD anchor when the window starts in a new calendar year", () => {
    // Window opens 2026-01-05: the anchor month-end (2025-12-31) is last year, so YTD restarts.
    expect(cumulativeAnchorsBeforeWindow(MONTHLY, "2026-01-05")).toEqual({
      ytd: 0,
      accumulated: 900,
    });
  });

  it("returns zeros when the window reaches back before all history", () => {
    expect(cumulativeAnchorsBeforeWindow(MONTHLY, "2020-01-01")).toEqual({
      ytd: 0,
      accumulated: 0,
    });
  });
});

describe("buildDailyPerfComboPoints", () => {
  const series = {
    points: [dayPoint("2026-03-01", 10), dayPoint("2026-03-02", -4), dayPoint("2026-03-03", 6)],
  };
  const lines = [line(1, [7, -5, 4]), line(2, [3, 1, 2])];
  const barAccounts = [
    { account_id: 1, bar_data_key: "pl_1" },
    { account_id: 2, bar_data_key: "pl_2" },
  ];

  it("emits per-account bars under the monthly keys and delta_total = their sum", () => {
    const pts = buildDailyPerfComboPoints({ series, lines, barAccounts, monthlyPointsAsc: MONTHLY });
    expect(pts).toHaveLength(3);
    expect(pts[0]).toMatchObject({ as_of_date: "2026-03-01", pl_1: 7, pl_2: 3, delta_total: 10 });
    expect(pts[1]).toMatchObject({ pl_1: -5, pl_2: 1, delta_total: -4 });
    for (const p of pts) {
      expect(p.delta_total).toBe((p.pl_1 as number) + (p.pl_2 as number));
    }
  });

  it("anchors the cumulative areas on the monthly series (continuity, not a restart at 0)", () => {
    const pts = buildDailyPerfComboPoints({ series, lines, barAccounts, monthlyPointsAsc: MONTHLY });
    // No month-end inside this window → falls back to the Feb close (ytd 150 / accum 1050).
    expect(pts[0]!.ytd_group).toBe(160);
    expect(pts[0]!.accumulated_earnings).toBe(1060);
    expect(pts[2]!.ytd_group).toBe(150 + 10 - 4 + 6);
    expect(pts[2]!.accumulated_earnings).toBe(1050 + 10 - 4 + 6);
  });

  it("matches the monthly chart AT a month-end inside the window, even mid-month starts", () => {
    // Window opens 2026-02-26, so it misses Feb 1–25: anchoring on the Jan close would leave the
    // area low by that partial month. The anchor is back-solved from the Feb month-end instead.
    const midMonth = {
      points: [
        dayPoint("2026-02-26", 2),
        dayPoint("2026-02-27", 3),
        dayPoint("2026-02-28", 5),
        dayPoint("2026-03-01", 4),
      ],
    };
    const pts = buildDailyPerfComboPoints({
      series: midMonth,
      lines: [line(1, [2, 3, 5, 4])],
      barAccounts: [{ account_id: 1, bar_data_key: "pl_1" }],
      monthlyPointsAsc: MONTHLY,
    });
    const feb = pts.find((p) => p.as_of_date === "2026-02-28")!;
    expect(feb.accumulated_earnings).toBe(1050); // == MONTHLY Feb accumulated_earnings
    expect(feb.ytd_group).toBe(150); // == MONTHLY Feb ytd_group
    // The following day keeps accruing from the corrected level.
    const mar = pts.find((p) => p.as_of_date === "2026-03-01")!;
    expect(mar.accumulated_earnings).toBe(1054);
  });

  it("resets YTD (but not the lifetime accumulation) at a new year inside the window", () => {
    const spanning = {
      points: [dayPoint("2025-12-30", 5), dayPoint("2025-12-31", 5), dayPoint("2026-01-01", 3)],
    };
    const spanningLines = [line(1, [5, 5, 3])];
    const pts = buildDailyPerfComboPoints({
      series: spanning,
      lines: spanningLines,
      barAccounts: [{ account_id: 1, bar_data_key: "pl_1" }],
      monthlyPointsAsc: MONTHLY,
    });
    // 2025-12-31 is inside the window, so both areas are pinned to that month-end's monthly
    // values (ytd 700 / accum 900); Jan 1 then restarts YTD while accumulation carries on.
    expect(pts[1]!.ytd_group).toBe(700);
    expect(pts[1]!.accumulated_earnings).toBe(900);
    expect(pts[2]!.ytd_group).toBe(3);
    expect(pts[2]!.accumulated_earnings).toBe(903);
  });

  it("contributes 0 for a bar account the daily payload has no line for (never invents a series)", () => {
    const pts = buildDailyPerfComboPoints({
      series,
      lines: [line(1, [7, -5, 4])],
      barAccounts,
      monthlyPointsAsc: MONTHLY,
    });
    expect(pts[0]).toMatchObject({ pl_1: 7, pl_2: 0, delta_total: 7 });
  });
});
