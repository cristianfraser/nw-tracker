import { describe, expect, it } from "vitest";
import {
  buildCcHistorialChartSeries,
  facturacionBarsOnMonthCloseDates,
  overlayBillingDetailMonthLines,
  type CcHistorialChartPoint,
} from "./creditCardChartSeries.js";
import type { CcBillingDetailStatementRow, CcFacturacionRow } from "./ccBillingViews.js";
import { usdForeign } from "./test/facturadoForeign.js";

const makeDetalle = (
  billing_month: string,
  overrides: Partial<CcBillingDetailStatementRow> = {}
): CcBillingDetailStatementRow => ({
  billing_month,
  as_of_date: `${billing_month}-23`,
  as_of_kind: "statement",
  total_facturado_actual: null,
  total_facturado: null,
  cupo_statement: 0,
  cuota_a_pagar_next_mes: 0,
  balance_statement: 0,
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
  pay_by_source: null,
  pay_by_iso: null,
  facturado: null,
  facturado_foreign: usdForeign(null, null),
  facturado_total: null,
  cuota_a_pagar: null,
  deuda_en_cuotas: null,
  is_open_month: false,
  is_provisional_close: false,
  close_date_source: "statement",
  provisional_estimate_total: null,
  ...overrides,
});

const bar = (p: CcHistorialChartPoint | undefined) =>
  p && {
    cuotas: p.facturado_cuotas,
    rest: p.facturado_rest,
    usd_clp: p.facturado_foreign_total,
    usd: p.facturado_foreign?.find((f) => f.currency === "usd")?.amount ?? null,
    total: p.facturado_total,
  };

describe("buildCcHistorialChartSeries", () => {
  it("stacks a facturación into the cuotas it bills, the rest of its CLP and its US$ in pesos", () => {
    const rows = buildCcHistorialChartSeries(
      [{ month: "2025-07", remaining_balance: 0, installment_payments: 100_000 }],
      [
        makeDetalle("2025-07", {
          total_facturado_actual: 2_583_795,
          total_facturado: 2_583_795,
          cupo_statement: 1_000_000,
          cuota_a_pagar_next_mes: 50_000,
          balance_statement: 3_583_795,
        }),
      ],
      [
        makeFacturacion("2025-07", {
          facturado: 2_503_795,
          facturado_foreign: usdForeign(84.77, 80_000),
          facturado_total: 2_583_795,
          cuota_a_pagar: 50_000,
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
      [makeDetalle("2026-10", { as_of_kind: "manual", total_facturado: 1_916_662 })],
      [
        makeFacturacion("2026-10", {
          facturado: 1_916_662,
          facturado_total: 1_916_662,
          cuota_a_pagar: 1_870_008,
          is_open_month: true,
        }),
      ]
    );
    expect(bar(rows[0])).toMatchObject({ cuotas: 1_870_008, rest: 46_654, usd_clp: null, total: 1_916_662 });
  });

  it("keeps a negative rest when the month's credits outweigh its únicos", () => {
    const rows = buildCcHistorialChartSeries(
      [],
      [makeDetalle("2025-03", { total_facturado: 150_000 })],
      [makeFacturacion("2025-03", { facturado: 150_000, facturado_total: 150_000, cuota_a_pagar: 200_000 })]
    );
    expect(bar(rows[0])).toMatchObject({ cuotas: 200_000, rest: -50_000, total: 150_000 });
  });

  it("gives a month with no cuotas an all-rest CLP bar", () => {
    const rows = buildCcHistorialChartSeries(
      [],
      [makeDetalle("2021-04", { total_facturado: 900_000 })],
      [makeFacturacion("2021-04", { facturado: 900_000, facturado_total: 900_000 })]
    );
    expect(bar(rows[0])).toMatchObject({ cuotas: null, rest: 900_000, total: 900_000 });
  });

  it("extends past detalle with projected months that carry only the plan's cuotas", () => {
    const detalle = [
      makeDetalle("2026-06", {
        total_facturado_actual: 2_000_000,
        total_facturado: 2_000_000,
        cupo_statement: 5_000_000,
        cuota_a_pagar_next_mes: 200_000,
        balance_statement: 6_800_000,
      }),
      makeDetalle("2026-07", {
        as_of_kind: "manual",
        total_facturado_actual: 500_000,
        total_facturado: 500_000,
        cupo_statement: 4_500_000,
        cuota_a_pagar_next_mes: 180_000,
        balance_statement: 4_820_000,
      }),
    ];
    const facturaciones = [
      makeFacturacion("2026-06", { facturado: 2_000_000, facturado_total: 2_000_000, cuota_a_pagar: 200_000 }),
      makeFacturacion("2026-07", {
        facturado: 500_000,
        facturado_total: 500_000,
        cuota_a_pagar: 180_000,
        is_open_month: true,
      }),
    ];
    const hist = [
      { month: "2026-06", remaining_balance: 5_000_000, installment_payments: 200_000, ledger_remaining_installments: 5_000_000 },
      { month: "2026-07", remaining_balance: 4_500_000, installment_payments: 180_000, ledger_remaining_installments: 4_500_000 },
      { month: "2026-08", remaining_balance: 4_200_000, installment_payments: 300_000, ledger_remaining_installments: 4_200_000 },
      { month: "2026-09", remaining_balance: 3_900_000, installment_payments: 300_000, ledger_remaining_installments: 3_900_000 },
      { month: "2026-10", remaining_balance: 0, installment_payments: 300_000, ledger_remaining_installments: 0 },
      { month: "2026-11", remaining_balance: 0, installment_payments: 0, ledger_remaining_installments: 0 },
    ];
    const rows = buildCcHistorialChartSeries(hist, detalle, facturaciones);
    expect(rows.map((r) => r.month)).toEqual(["2026-06", "2026-07", "2026-08", "2026-09", "2026-10"]);
    const aug = rows.find((r) => r.month === "2026-08");
    expect(aug).toMatchObject({ cupo_en_cuotas: 4_200_000, balance_total: 4_200_000 });
    expect(bar(aug)).toEqual({ cuotas: 300_000, rest: null, usd_clp: null, usd: null, total: 300_000 });
    expect(rows.find((r) => r.month === "2026-11")).toBeUndefined();
  });

  it("fills interior gap months in detalle with nulls", () => {
    // Detalle has Jul and Nov but not Aug/Sep/Oct — those are real import gaps
    const rows = buildCcHistorialChartSeries(
      [],
      [
        makeDetalle("2025-07", { total_facturado: 1_000_000, cupo_statement: 500_000, balance_statement: 1_500_000 }),
        makeDetalle("2025-11", { total_facturado: 2_000_000, cupo_statement: 400_000, balance_statement: 2_400_000 }),
      ],
      [
        makeFacturacion("2025-07", { facturado: 1_000_000, facturado_total: 1_000_000 }),
        makeFacturacion("2025-11", { facturado: 2_000_000, facturado_total: 2_000_000 }),
      ]
    );
    expect(rows.map((r) => r.month)).toEqual(["2025-07", "2025-08", "2025-09", "2025-10", "2025-11"]);
    expect(rows.find((r) => r.month === "2025-07")?.facturado_total).toBe(1_000_000);
    expect(rows.find((r) => r.month === "2025-11")?.facturado_total).toBe(2_000_000);
    for (const ym of ["2025-08", "2025-09", "2025-10"]) {
      const row = rows.find((r) => r.month === ym);
      expect(bar(row)).toEqual({ cuotas: null, rest: null, usd_clp: null, usd: null, total: null });
      expect(row?.cupo_en_cuotas).toBeNull();
      expect(row?.balance_total).toBeNull();
    }
  });

  it("splits an open month no line has landed in yet (no facturación row) as CLP", () => {
    const rows = buildCcHistorialChartSeries(
      [],
      [makeDetalle("2026-10", { as_of_kind: "manual", total_facturado: 30_000, cuota_a_pagar_next_mes: 30_000 })],
      []
    );
    expect(bar(rows[0])).toEqual({ cuotas: 30_000, rest: 0, usd_clp: null, usd: null, total: 30_000 });
  });

  it("throws on cuotas billed without a CLP facturado to hold them", () => {
    expect(() =>
      buildCcHistorialChartSeries(
        [],
        [makeDetalle("2025-07")],
        [makeFacturacion("2025-07", { facturado_foreign: usdForeign(10, 9_000), cuota_a_pagar: 50_000 })]
      )
    ).toThrow(/no CLP facturado/);
  });

  it("plots both lines from the daily data the sampler returns, never from the billing frame", () => {
    // July billed 100k of cuotas at its close, paid after month-end: the table's cupo (still
    // unbilled, 400k) pairs with facturado; the chart lines are the daily values at 31/07.
    const detalle = [
      makeDetalle("2025-07", { cupo_statement: 400_000, balance_statement: 1_400_000 }),
      makeDetalle("2025-09", { cupo_statement: 200_000, balance_statement: 1_000_000 }),
    ];
    const asked: string[][] = [];
    const rows = buildCcHistorialChartSeries([], detalle, [], {
      linesForMonths: (months) => {
        asked.push([...months]);
        return new Map([
          ["2025-07", { balance_clp: 1_500_000, plan_debt: 500_000 }],
          ["2025-08", { balance_clp: 900_000, plan_debt: 400_000 }],
          ["2025-09", { balance_clp: null, plan_debt: null }],
        ]);
      },
    });
    expect(asked).toEqual([["2025-07", "2025-08", "2025-09"]]);
    expect(rows.map((r) => r.cupo_en_cuotas)).toEqual([500_000, 400_000, null]);
    expect(rows.map((r) => r.balance_total)).toEqual([1_500_000, 900_000, null]);
  });

  it("overlays the detalle's month frame from the sampled lines, the statement frame untouched", () => {
    const rows = overlayBillingDetailMonthLines(
      [
        makeDetalle("2025-07", { cupo_statement: 400_000, balance_statement: 1_400_000 }),
        makeDetalle("2025-08", { cupo_statement: 300_000, balance_statement: 1_300_000 }),
      ],
      new Map([
        ["2025-07", { balance_clp: 1_500_000, plan_debt: 500_000 }],
        ["2025-08", { balance_clp: null, plan_debt: null }],
      ])
    );
    expect(rows.map((r) => [r.cupo_statement, r.balance_statement])).toEqual([
      [400_000, 1_400_000],
      [300_000, 1_300_000],
    ]);
    expect(rows.map((r) => [r.cupo_en_cuotas, r.balance_total])).toEqual([
      [500_000, 1_500_000],
      [null, null],
    ]);
    // No sample at all: the month frame is null on every row.
    expect(overlayBillingDetailMonthLines([makeDetalle("2025-07")], null)[0]).toMatchObject({
      cupo_en_cuotas: null,
      balance_total: null,
    });
    // A month the sampler was never asked about breaks the one-sample contract.
    expect(() => overlayBillingDetailMonthLines([makeDetalle("2025-09")], new Map())).toThrow(/2025-09/);
  });

  it("keeps the billing-frame columns when the sampler has no data", () => {
    const rows = buildCcHistorialChartSeries(
      [],
      [makeDetalle("2025-07", { cupo_statement: 400_000, balance_statement: 1_400_000 })],
      [],
      { linesForMonths: () => null }
    );
    expect(rows[0]?.cupo_en_cuotas).toBe(400_000);
    expect(rows[0]?.balance_total).toBe(1_400_000);
  });

  it("sums a group's bars from its cards' own series, never from the merged facturaciones", () => {
    // Card A has an open October facturación; card B only projects October's cuotas. The merged
    // facturación row is A's alone, so splitting it would drop B's 32.764.
    const a = buildCcHistorialChartSeries(
      [],
      [makeDetalle("2026-10", { as_of_kind: "manual", total_facturado: 1_916_662 })],
      [
        makeFacturacion("2026-10", {
          facturado: 1_916_662,
          facturado_total: 1_916_662,
          cuota_a_pagar: 1_870_008,
          is_open_month: true,
        }),
      ]
    );
    const b = buildCcHistorialChartSeries(
      [],
      [makeDetalle("2026-10", { as_of_kind: "manual", cuota_a_pagar_next_mes: 32_764, projected: true })],
      []
    );
    const merged = buildCcHistorialChartSeries(
      [],
      [
        makeDetalle("2026-10", {
          as_of_kind: "manual",
          total_facturado: 1_916_662,
          cuota_a_pagar_next_mes: 1_902_772,
        }),
      ],
      [
        makeFacturacion("2026-10", {
          facturado: 1_916_662,
          facturado_total: 1_916_662,
          cuota_a_pagar: 1_870_008,
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
      [makeDetalle("2026-12", { cuota_a_pagar_next_mes: 10_000, projected: true })],
      []
    );
    expect(() =>
      buildCcHistorialChartSeries([], [makeDetalle("2026-10")], [], { memberSeries: [card] })
    ).toThrow(/outside the group's months/);
  });
});

describe("facturacionBarsOnMonthCloseDates", () => {
  const monthPoint = (month: string, cuotas: number | null, rest: number | null): CcHistorialChartPoint => ({
    month,
    facturado_cuotas: cuotas,
    facturado_rest: rest,
    facturado_foreign_total: null,
    facturado_foreign: null,
    facturado_total: cuotas == null && rest == null ? null : (cuotas ?? 0) + (rest ?? 0),
    cupo_en_cuotas: null,
    balance_total: null,
  });
  const row = (b: { as_of_date: string; facturado_cuotas: number | null; facturado_rest: number | null; facturado_total: number | null }) =>
    [b.as_of_date, b.facturado_cuotas, b.facturado_rest, b.facturado_total];

  it("stacks every card's bar of a billing month on the month's latest close", () => {
    const bars = facturacionBarsOnMonthCloseDates([
      {
        points: [monthPoint("2026-08", 100, 900), monthPoint("2026-09", null, null), monthPoint("2026-10", 50, null)],
        closeIsoForMonth: (ym) => ({ "2026-08": "2026-08-25", "2026-10": "2026-10-24" })[ym]!,
      },
      {
        points: [monthPoint("2026-08", 10, 90), monthPoint("2026-10", 5, 20)],
        closeIsoForMonth: (ym) => ({ "2026-08": "2026-08-26", "2026-10": "2026-10-24" })[ym]!,
      },
    ]);
    expect(bars.map(row)).toEqual([
      ["2026-08-26", 110, 990, 1_100],
      ["2026-10-24", 55, 20, 75],
    ]);
  });

  it("a card with no bar in a month lends it neither pesos nor its close", () => {
    const bars = facturacionBarsOnMonthCloseDates([
      {
        points: [monthPoint("2026-08", 100, 900)],
        closeIsoForMonth: () => "2026-08-24",
      },
      {
        // Projected only in August (no facturado); its estimated close is later than the other's.
        points: [monthPoint("2026-08", null, null), monthPoint("2026-09", 5, null)],
        closeIsoForMonth: (ym) => ({ "2026-08": "2026-08-28", "2026-09": "2026-09-26" })[ym]!,
      },
    ]);
    expect(bars.map(row)).toEqual([
      ["2026-08-24", 100, 900, 1_000],
      ["2026-09-26", 5, null, 5],
    ]);
  });

  it("a card alone keeps its own closes", () => {
    const bars = facturacionBarsOnMonthCloseDates([
      {
        points: [monthPoint("2026-08", 1, 2), monthPoint("2026-09", 3, 4)],
        closeIsoForMonth: (ym) => ({ "2026-08": "2026-08-24", "2026-09": "2026-09-24" })[ym]!,
      },
    ]);
    expect(bars.map((b) => b.as_of_date)).toEqual(["2026-08-24", "2026-09-24"]);
  });
});
