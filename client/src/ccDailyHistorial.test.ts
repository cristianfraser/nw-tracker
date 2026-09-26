import { describe, expect, it } from "vitest";
import { buildCcDailyHistorialRows } from "./ccDailyHistorial";
import type { DailySeriesResponse } from "./types";

const TODAY = "2026-07-01";

const NO_BAR = {
  facturado_cuotas_clp: null,
  facturado_rest_clp: null,
  facturado_usd_clp: null,
  facturado_usd: null,
  facturado_total_clp: null,
};

const facturacionBar = (as_of_date: string, cuotas: number, rest: number) => ({
  as_of_date,
  facturado_cuotas_clp: cuotas,
  facturado_rest_clp: rest,
  facturado_usd_clp: null,
  facturado_usd: null,
  facturado_total_clp: cuotas + rest,
});

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
  it("maps the CC block onto the two lines and appends the plan tail", () => {
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
      { month: "2026-06-29", ...NO_BAR, cupo_en_cuotas_clp: 300, balance_total_clp: 500 },
      { month: "2026-06-30", ...NO_BAR, cupo_en_cuotas_clp: 300, balance_total_clp: 520 },
      { month: TODAY, ...NO_BAR, cupo_en_cuotas_clp: 200, balance_total_clp: 510 },
      { month: "2026-07-02", ...NO_BAR, cupo_en_cuotas_clp: 200, balance_total_clp: 210 },
    ]);
  });

  it("puts each facturación bar on its close day, in the past or in the plan tail", () => {
    const rows = buildCcDailyHistorialRows(
      daily({
        cc_owed: [null, 500, 520, 510],
        cc_installment_debt: [null, 300, 300, 200],
        cc_plan_tail: [{ as_of_date: "2026-07-02", plan_debt_clp: 200, balance_clp: 210 }],
        cc_facturacion_bars: [facturacionBar("2026-06-30", 100, 400), facturacionBar("2026-07-02", 50, 0)],
      }),
      "total",
      TODAY
    )!;
    expect(rows.map((r) => [r.month, r.facturado_cuotas_clp, r.facturado_rest_clp, r.facturado_total_clp])).toEqual([
      ["2026-06-29", null, null, null],
      ["2026-06-30", 100, 400, 500],
      [TODAY, null, null, null],
      ["2026-07-02", 50, 0, 50],
    ]);
    // The lines are untouched on a bar day.
    expect(rows[1]).toMatchObject({ cupo_en_cuotas_clp: 300, balance_total_clp: 520 });
  });

  it("runs the grid on, lines empty, to a close past the plan tail's end", () => {
    const rows = buildCcDailyHistorialRows(
      daily({
        cc_owed: [null, 500, 520, 510],
        cc_installment_debt: [null, 300, 300, 200],
        cc_facturacion_bars: [facturacionBar("2026-07-03", 0, 80)],
      }),
      "total",
      TODAY
    )!;
    expect(rows.slice(-3)).toEqual([
      { month: "2026-07-01", ...NO_BAR, cupo_en_cuotas_clp: 200, balance_total_clp: 510 },
      { month: "2026-07-02", ...NO_BAR, cupo_en_cuotas_clp: null, balance_total_clp: null },
      {
        month: "2026-07-03",
        ...NO_BAR,
        facturado_cuotas_clp: 0,
        facturado_rest_clp: 80,
        facturado_total_clp: 80,
        cupo_en_cuotas_clp: null,
        balance_total_clp: null,
      },
    ]);
  });

  it("throws on a bar before the daily grid (the server clips them to its first day)", () => {
    expect(() =>
      buildCcDailyHistorialRows(
        daily({ cc_owed: [null, 500, 520, 510], cc_facturacion_bars: [facturacionBar("2026-06-01", 1, 1)] }),
        "total",
        TODAY
      )
    ).toThrow(/off the daily grid/);
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
