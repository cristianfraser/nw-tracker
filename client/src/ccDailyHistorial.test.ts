import { describe, expect, it } from "vitest";
import { buildCcDailyHistorialRows } from "./ccDailyHistorial";
import type { DailySeriesResponse } from "./types";

const TODAY = "2026-07-01";

function daily(over: Partial<DailySeriesResponse>): DailySeriesResponse {
  return {
    unit: "clp",
    end_ymd: TODAY,
    baseline: { as_of_date: "2026-06-27", value: null },
    points: [
      { as_of_date: "2026-06-28", value: null, delta: null, flow: 0, pl: null, pct: null },
      { as_of_date: "2026-06-29", value: 500, delta: null, flow: 0, pl: null, pct: null },
      { as_of_date: "2026-06-30", value: 520, delta: 20, flow: 0, pl: 20, pct: 0.04 },
      { as_of_date: TODAY, value: 510, delta: -10, flow: 0, pl: -10, pct: -0.019 },
    ],
    ...over,
  };
}

describe("buildCcDailyHistorialRows", () => {
  it("maps the CC block onto the two lines, appends the plan tail and keeps the bars null", () => {
    const rows = buildCcDailyHistorialRows(
      daily({
        cc_owed: [null, 500, 520, 510],
        cc_installment_debt: [null, 300, 300, 200],
        cc_plan_tail: [{ as_of_date: "2026-07-02", plan_debt_clp: 200, balance_clp: 210 }],
      }),
      "total",
      TODAY
    );
    expect(rows).toEqual([
      // `total` starts flush at the first data day — the leading empty day is clipped.
      { month: "2026-06-29", installment_payments_clp: 0, facturado_clp: null, cupo_en_cuotas_clp: 300, balance_total_clp: 500 },
      { month: "2026-06-30", installment_payments_clp: 0, facturado_clp: null, cupo_en_cuotas_clp: 300, balance_total_clp: 520 },
      { month: TODAY, installment_payments_clp: 0, facturado_clp: null, cupo_en_cuotas_clp: 200, balance_total_clp: 510 },
      { month: "2026-07-02", installment_payments_clp: 0, facturado_clp: null, cupo_en_cuotas_clp: 200, balance_total_clp: 210 },
    ]);
  });

  it("reads saldo total from cc_owed, never from the bucket points (a Pasivos root point includes the mortgage)", () => {
    const rows = buildCcDailyHistorialRows(
      daily({ cc_owed: [null, 100, 100, 100], cc_installment_debt: [null, null, null, null] }),
      "total",
      TODAY
    )!;
    expect(rows.map((r) => r.balance_total_clp)).toEqual([100, 100, 100]);
  });

  it("is null without the CC block (not a CC scope) and without points", () => {
    expect(buildCcDailyHistorialRows(daily({}), "total", TODAY)).toBeNull();
    expect(buildCcDailyHistorialRows(daily({ cc_owed: [], points: [] }), "total", TODAY)).toBeNull();
  });

  it("clips the leading empty grid to the range window, keeping the 20% lead", () => {
    // 90d range: cutoff 2026-04-02; first data 06-29 − 18 days (20 % of 90) = 06-11 is later,
    // so the window starts there — the 06-28 empty row (before the data) is still inside it.
    const rows = buildCcDailyHistorialRows(
      daily({ cc_owed: [null, 500, 520, 510], cc_installment_debt: [null, 300, 300, 200] }),
      "90d",
      TODAY
    )!;
    expect(rows.map((r) => r.month)).toEqual(["2026-06-28", "2026-06-29", "2026-06-30", TODAY]);
  });
});
