import { describe, expect, it } from "vitest";
import {
  buildCcHistorialChartSeries,
  facturacionBarsOnCloseDates,
  type CcHistorialChartPoint,
} from "./creditCardChartSeries.js";
import type { CcBillingDetailMonthRow, CcFacturacionRow } from "./ccBillingViews.js";

const makeDetalle = (
  billing_month: string,
  overrides: Partial<CcBillingDetailMonthRow> = {}
): CcBillingDetailMonthRow => ({
  billing_month,
  as_of_date: `${billing_month}-23`,
  as_of_kind: "statement",
  total_facturado_actual_clp: null,
  total_facturado_clp: null,
  cupo_en_cuotas_clp: 0,
  cuota_a_pagar_next_mes_clp: 0,
  balance_total_clp: 0,
  ...overrides,
});

const makeFacturacion = (
  billing_month: string,
  overrides: Partial<CcFacturacionRow> = {}
): CcFacturacionRow => ({
  billing_month,
  close_date: `23/${billing_month.slice(5, 7)}/${billing_month.slice(0, 4)}`,
  close_date_iso: `${billing_month}-23`,
  pay_by: null,
  pay_by_iso: null,
  facturado_clp: null,
  facturado_usd: null,
  facturado_usd_clp: null,
  facturado_total_clp: null,
  cuota_a_pagar_clp: null,
  is_open_month: false,
  is_provisional_close: false,
  close_date_source: "statement",
  provisional_estimate_total_clp: null,
  usd_rate_clp: null,
  usd_rate_source: null,
  ...overrides,
});

const bar = (p: CcHistorialChartPoint | undefined) =>
  p && {
    cuotas: p.facturado_cuotas_clp,
    rest: p.facturado_rest_clp,
    usd_clp: p.facturado_usd_clp,
    usd: p.facturado_usd,
    total: p.facturado_total_clp,
  };

describe("buildCcHistorialChartSeries", () => {
  it("stacks a facturación into the cuotas it bills, the rest of its CLP and its US$ in pesos", () => {
    const rows = buildCcHistorialChartSeries(
      [{ month: "2025-07", remaining_balance_clp: 0, installment_payments_clp: 100_000 }],
      [
        makeDetalle("2025-07", {
          total_facturado_actual_clp: 2_583_795,
          total_facturado_clp: 2_583_795,
          cupo_en_cuotas_clp: 1_000_000,
          cuota_a_pagar_next_mes_clp: 50_000,
          balance_total_clp: 3_583_795,
        }),
      ],
      [
        makeFacturacion("2025-07", {
          facturado_clp: 2_503_795,
          facturado_usd: 84.77,
          facturado_usd_clp: 80_000,
          facturado_total_clp: 2_583_795,
          cuota_a_pagar_clp: 50_000,
        }),
      ]
    );
    // The facturación's cuota a pagar, not the calendar-month historial's 100k.
    expect(bar(rows[0])).toEqual({
      cuotas: 50_000,
      rest: 2_453_795,
      usd_clp: 80_000,
      usd: 84.77,
      total: 2_583_795,
    });
  });

  it("reads an open month the same way: its scheduled cuotas plus the únicos so far", () => {
    const rows = buildCcHistorialChartSeries(
      [],
      [makeDetalle("2026-10", { as_of_kind: "manual", total_facturado_clp: 1_916_662 })],
      [
        makeFacturacion("2026-10", {
          facturado_clp: 1_916_662,
          facturado_total_clp: 1_916_662,
          cuota_a_pagar_clp: 1_870_008,
          is_open_month: true,
        }),
      ]
    );
    expect(bar(rows[0])).toMatchObject({ cuotas: 1_870_008, rest: 46_654, usd_clp: null, total: 1_916_662 });
  });

  it("keeps a negative rest when the month's credits outweigh its únicos", () => {
    const rows = buildCcHistorialChartSeries(
      [],
      [makeDetalle("2025-03", { total_facturado_clp: 150_000 })],
      [makeFacturacion("2025-03", { facturado_clp: 150_000, facturado_total_clp: 150_000, cuota_a_pagar_clp: 200_000 })]
    );
    expect(bar(rows[0])).toMatchObject({ cuotas: 200_000, rest: -50_000, total: 150_000 });
  });

  it("gives a month with no cuotas an all-rest CLP bar", () => {
    const rows = buildCcHistorialChartSeries(
      [],
      [makeDetalle("2021-04", { total_facturado_clp: 900_000 })],
      [makeFacturacion("2021-04", { facturado_clp: 900_000, facturado_total_clp: 900_000 })]
    );
    expect(bar(rows[0])).toMatchObject({ cuotas: null, rest: 900_000, total: 900_000 });
  });

  it("extends past detalle with projected months that carry only the plan's cuotas", () => {
    const detalle = [
      makeDetalle("2026-06", {
        total_facturado_actual_clp: 2_000_000,
        total_facturado_clp: 2_000_000,
        cupo_en_cuotas_clp: 5_000_000,
        cuota_a_pagar_next_mes_clp: 200_000,
        balance_total_clp: 6_800_000,
      }),
      makeDetalle("2026-07", {
        as_of_kind: "manual",
        total_facturado_actual_clp: 500_000,
        total_facturado_clp: 500_000,
        cupo_en_cuotas_clp: 4_500_000,
        cuota_a_pagar_next_mes_clp: 180_000,
        balance_total_clp: 4_820_000,
      }),
    ];
    const facturaciones = [
      makeFacturacion("2026-06", { facturado_clp: 2_000_000, facturado_total_clp: 2_000_000, cuota_a_pagar_clp: 200_000 }),
      makeFacturacion("2026-07", {
        facturado_clp: 500_000,
        facturado_total_clp: 500_000,
        cuota_a_pagar_clp: 180_000,
        is_open_month: true,
      }),
    ];
    const hist = [
      { month: "2026-06", remaining_balance_clp: 5_000_000, installment_payments_clp: 200_000, ledger_remaining_installments_clp: 5_000_000 },
      { month: "2026-07", remaining_balance_clp: 4_500_000, installment_payments_clp: 180_000, ledger_remaining_installments_clp: 4_500_000 },
      { month: "2026-08", remaining_balance_clp: 4_200_000, installment_payments_clp: 300_000, ledger_remaining_installments_clp: 4_200_000 },
      { month: "2026-09", remaining_balance_clp: 3_900_000, installment_payments_clp: 300_000, ledger_remaining_installments_clp: 3_900_000 },
      { month: "2026-10", remaining_balance_clp: 0, installment_payments_clp: 300_000, ledger_remaining_installments_clp: 0 },
      { month: "2026-11", remaining_balance_clp: 0, installment_payments_clp: 0, ledger_remaining_installments_clp: 0 },
    ];
    const rows = buildCcHistorialChartSeries(hist, detalle, facturaciones);
    expect(rows.map((r) => r.month)).toEqual(["2026-06", "2026-07", "2026-08", "2026-09", "2026-10"]);
    const aug = rows.find((r) => r.month === "2026-08");
    expect(aug).toMatchObject({ cupo_en_cuotas_clp: 4_200_000, balance_total_clp: 4_200_000 });
    expect(bar(aug)).toEqual({ cuotas: 300_000, rest: null, usd_clp: null, usd: null, total: 300_000 });
    expect(rows.find((r) => r.month === "2026-11")).toBeUndefined();
  });

  it("fills interior gap months in detalle with nulls", () => {
    // Detalle has Jul and Nov but not Aug/Sep/Oct — those are real import gaps
    const rows = buildCcHistorialChartSeries(
      [],
      [
        makeDetalle("2025-07", { total_facturado_clp: 1_000_000, cupo_en_cuotas_clp: 500_000, balance_total_clp: 1_500_000 }),
        makeDetalle("2025-11", { total_facturado_clp: 2_000_000, cupo_en_cuotas_clp: 400_000, balance_total_clp: 2_400_000 }),
      ],
      [
        makeFacturacion("2025-07", { facturado_clp: 1_000_000, facturado_total_clp: 1_000_000 }),
        makeFacturacion("2025-11", { facturado_clp: 2_000_000, facturado_total_clp: 2_000_000 }),
      ]
    );
    expect(rows.map((r) => r.month)).toEqual(["2025-07", "2025-08", "2025-09", "2025-10", "2025-11"]);
    expect(rows.find((r) => r.month === "2025-07")?.facturado_total_clp).toBe(1_000_000);
    expect(rows.find((r) => r.month === "2025-11")?.facturado_total_clp).toBe(2_000_000);
    for (const ym of ["2025-08", "2025-09", "2025-10"]) {
      const row = rows.find((r) => r.month === ym);
      expect(bar(row)).toEqual({ cuotas: null, rest: null, usd_clp: null, usd: null, total: null });
      expect(row?.cupo_en_cuotas_clp).toBeNull();
      expect(row?.balance_total_clp).toBeNull();
    }
  });

  it("splits an open month no line has landed in yet (no facturación row) as CLP", () => {
    const rows = buildCcHistorialChartSeries(
      [],
      [makeDetalle("2026-10", { as_of_kind: "manual", total_facturado_clp: 30_000, cuota_a_pagar_next_mes_clp: 30_000 })],
      []
    );
    expect(bar(rows[0])).toEqual({ cuotas: 30_000, rest: 0, usd_clp: null, usd: null, total: 30_000 });
  });

  it("throws on cuotas billed without a CLP facturado to hold them", () => {
    expect(() =>
      buildCcHistorialChartSeries(
        [],
        [makeDetalle("2025-07")],
        [makeFacturacion("2025-07", { facturado_usd: 10, facturado_usd_clp: 9_000, cuota_a_pagar_clp: 50_000 })]
      )
    ).toThrow(/no CLP facturado/);
  });

  it("plots «deuda en cuotas» from the month-end sampler and keeps the billing frame for balances", () => {
    // July billed 100k of cuotas at its close, paid after month-end: the table's cupo (still
    // unbilled, 400k) pairs with facturado; the chart line (still unpaid at 31/07, 500k) is the
    // daily line at that month-end.
    const detalle = [
      makeDetalle("2025-07", { cupo_en_cuotas_clp: 400_000, balance_total_clp: 1_400_000 }),
      makeDetalle("2025-09", { cupo_en_cuotas_clp: 200_000, balance_total_clp: 1_000_000 }),
    ];
    const asked: string[][] = [];
    const rows = buildCcHistorialChartSeries([], detalle, [], {
      installmentDebtForMonths: (months) => {
        asked.push([...months]);
        return new Map<string, number | null>([
          ["2025-07", 500_000],
          ["2025-08", 400_000],
          ["2025-09", null],
        ]);
      },
    });
    expect(asked).toEqual([["2025-07", "2025-08", "2025-09"]]);
    expect(rows.map((r) => r.cupo_en_cuotas_clp)).toEqual([500_000, 400_000, null]);
    expect(rows.map((r) => r.balance_total_clp)).toEqual([1_400_000, null, 1_000_000]);
  });

  it("keeps the billing-frame column when the sampler has no schedule", () => {
    const rows = buildCcHistorialChartSeries([], [makeDetalle("2025-07", { cupo_en_cuotas_clp: 400_000 })], [], {
      installmentDebtForMonths: () => null,
    });
    expect(rows[0]?.cupo_en_cuotas_clp).toBe(400_000);
  });

  it("sums a group's bars from its cards' own series, never from the merged facturaciones", () => {
    // Card A has an open October facturación; card B only projects October's cuotas. The merged
    // facturación row is A's alone, so splitting it would drop B's 32.764.
    const a = buildCcHistorialChartSeries(
      [],
      [makeDetalle("2026-10", { as_of_kind: "manual", total_facturado_clp: 1_916_662 })],
      [
        makeFacturacion("2026-10", {
          facturado_clp: 1_916_662,
          facturado_total_clp: 1_916_662,
          cuota_a_pagar_clp: 1_870_008,
          is_open_month: true,
        }),
      ]
    );
    const b = buildCcHistorialChartSeries(
      [],
      [makeDetalle("2026-10", { as_of_kind: "manual", cuota_a_pagar_next_mes_clp: 32_764, projected: true })],
      []
    );
    const merged = buildCcHistorialChartSeries(
      [],
      [
        makeDetalle("2026-10", {
          as_of_kind: "manual",
          total_facturado_clp: 1_916_662,
          cuota_a_pagar_next_mes_clp: 1_902_772,
        }),
      ],
      [
        makeFacturacion("2026-10", {
          facturado_clp: 1_916_662,
          facturado_total_clp: 1_916_662,
          cuota_a_pagar_clp: 1_870_008,
          is_open_month: true,
        }),
      ],
      { memberSeries: [a, b] }
    );
    expect(bar(merged[0])).toEqual({
      cuotas: 1_902_772,
      rest: 46_654,
      usd_clp: null,
      usd: null,
      total: 1_949_426,
    });
  });

  it("throws when a card's bar falls outside the group's months", () => {
    const card = buildCcHistorialChartSeries(
      [],
      [makeDetalle("2026-12", { cuota_a_pagar_next_mes_clp: 10_000, projected: true })],
      []
    );
    expect(() =>
      buildCcHistorialChartSeries([], [makeDetalle("2026-10")], [], { memberSeries: [card] })
    ).toThrow(/outside the group's months/);
  });
});

describe("facturacionBarsOnCloseDates", () => {
  const monthPoint = (month: string, cuotas: number | null, rest: number | null): CcHistorialChartPoint => ({
    month,
    facturado_cuotas_clp: cuotas,
    facturado_rest_clp: rest,
    facturado_usd_clp: null,
    facturado_usd: null,
    facturado_total_clp: cuotas == null && rest == null ? null : (cuotas ?? 0) + (rest ?? 0),
    cupo_en_cuotas_clp: null,
    balance_total_clp: null,
  });

  it("puts each card's bar on its own close and stacks cards that close the same day", () => {
    const bars = facturacionBarsOnCloseDates([
      {
        points: [monthPoint("2026-08", 100, 900), monthPoint("2026-09", null, null), monthPoint("2026-10", 50, null)],
        closeIsoForMonth: (ym) => ({ "2026-08": "2026-08-25", "2026-10": "2026-10-24" })[ym]!,
      },
      {
        points: [monthPoint("2026-08", 10, 90), monthPoint("2026-10", 5, 20)],
        closeIsoForMonth: (ym) => ({ "2026-08": "2026-08-26", "2026-10": "2026-10-24" })[ym]!,
      },
    ]);
    expect(bars.map((b) => [b.as_of_date, b.facturado_cuotas_clp, b.facturado_rest_clp, b.facturado_total_clp])).toEqual([
      ["2026-08-25", 100, 900, 1_000],
      ["2026-08-26", 10, 90, 100],
      ["2026-10-24", 55, 20, 75],
    ]);
  });
});
