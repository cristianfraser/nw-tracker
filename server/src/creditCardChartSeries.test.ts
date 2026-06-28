import { describe, expect, it } from "vitest";
import {
  buildCcBillingMonthChartSeries,
  buildCcHistorialChartSeries,
} from "./creditCardChartSeries.js";
import type { CcBillingDetailMonthRow, CcFacturacionRow } from "./ccBillingViews.js";
import type { CcFinancingPlMonthRow } from "./creditCardPerformancePl.js";

describe("buildCcBillingMonthChartSeries", () => {
  it("merges facturaciones and financing rows by billing month", () => {
    const facturaciones: CcFacturacionRow[] = [
      {
        billing_month: "2025-06",
        close_date: "23/06/2025",
        close_date_iso: "2025-06-23",
        pay_by: null,
        pay_by_iso: null,
        facturado_clp: 4_484_823,
        facturado_usd: null,
        facturado_usd_clp: null,
        facturado_total_clp: 4_484_823,
        cuota_a_pagar_clp: null,
        is_open_month: false,
      },
    ];
    const financing: CcFinancingPlMonthRow[] = [
      {
        billing_month: "2025-06",
        statement_charges_clp: 12_000,
        installment_interest_clp: 0,
        financing_cost_clp: 12_000,
        ytd_financing_cost_clp: 12_000,
        cumulative_financing_cost_clp: 12_000,
      },
    ];
    const pts = buildCcBillingMonthChartSeries(facturaciones, financing);
    expect(pts).toHaveLength(1);
    expect(pts[0]).toMatchObject({
      billing_month: "2025-06",
      facturado_clp: 4_484_823,
      financing_cost_clp: 12_000,
      ytd_financing_cost_clp: 12_000,
    });
  });

  it("fills interior gap months with nulls", () => {
    const facturaciones: CcFacturacionRow[] = [
      {
        billing_month: "2025-03",
        close_date: "23/03/2025",
        close_date_iso: "2025-03-23",
        pay_by: null,
        pay_by_iso: null,
        facturado_clp: 1_000_000,
        facturado_usd: null,
        facturado_usd_clp: null,
        facturado_total_clp: 1_000_000,
        cuota_a_pagar_clp: null,
        is_open_month: false,
      },
      {
        billing_month: "2025-07",
        close_date: "23/07/2025",
        close_date_iso: "2025-07-23",
        pay_by: null,
        pay_by_iso: null,
        facturado_clp: 2_000_000,
        facturado_usd: null,
        facturado_usd_clp: null,
        facturado_total_clp: 2_000_000,
        cuota_a_pagar_clp: null,
        is_open_month: false,
      },
    ];
    const pts = buildCcBillingMonthChartSeries(facturaciones, []);
    const months = pts.map((p) => p.billing_month);
    expect(months).toEqual(["2025-03", "2025-04", "2025-05", "2025-06", "2025-07"]);
    expect(pts.find((p) => p.billing_month === "2025-03")?.facturado_clp).toBe(1_000_000);
    expect(pts.find((p) => p.billing_month === "2025-04")?.facturado_clp).toBeNull();
    expect(pts.find((p) => p.billing_month === "2025-05")?.facturado_clp).toBeNull();
    expect(pts.find((p) => p.billing_month === "2025-06")?.facturado_clp).toBeNull();
    expect(pts.find((p) => p.billing_month === "2025-07")?.facturado_clp).toBe(2_000_000);
  });
});

describe("buildCcHistorialChartSeries", () => {
  const makeDetalle = (billing_month: string, overrides: Partial<CcBillingDetailMonthRow> = {}): CcBillingDetailMonthRow => ({
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

  it("uses facturado_total_clp from facturaciones", () => {
    const facturaciones: CcFacturacionRow[] = [
      {
        billing_month: "2025-07",
        close_date: "23/07/2025",
        close_date_iso: "2025-07-23",
        pay_by: null,
        pay_by_iso: null,
        facturado_clp: 2_503_795,
        facturado_usd: 84.77,
        facturado_usd_clp: 80_000,
        facturado_total_clp: 2_583_795,
        cuota_a_pagar_clp: null,
        is_open_month: false,
      },
    ];
    const rows = buildCcHistorialChartSeries(
      [{ month: "2025-07", remaining_balance_clp: 0, installment_payments_clp: 100_000 }],
      [makeDetalle("2025-07", {
        total_facturado_actual_clp: 2_583_795,
        total_facturado_clp: 2_583_795,
        cupo_en_cuotas_clp: 1_000_000,
        cuota_a_pagar_next_mes_clp: 50_000,
        balance_total_clp: 3_533_795,
      })],
      facturaciones
    );
    expect(rows[0]?.facturado_clp).toBe(2_583_795);
    expect(rows[0]?.installment_payments_clp).toBe(50_000);
  });

  it("uses facturacion cuota a pagar for pagos del mes, not calendar-month historial", () => {
    const facturaciones: CcFacturacionRow[] = [
      {
        billing_month: "2026-07",
        close_date: "20/07/2026",
        close_date_iso: "2026-07-20",
        pay_by: "10/08/2026",
        pay_by_iso: "2026-08-10",
        facturado_clp: 561_728,
        facturado_usd: null,
        facturado_usd_clp: null,
        facturado_total_clp: 561_728,
        cuota_a_pagar_clp: 561_728,
        is_open_month: true,
      },
    ];
    const rows = buildCcHistorialChartSeries(
      [
        {
          month: "2026-07",
          remaining_balance_clp: 3_821_051,
          installment_payments_clp: 472_746,
          ledger_remaining_installments_clp: 3_821_051,
        },
      ],
      [makeDetalle("2026-07", {
        as_of_kind: "manual",
        total_facturado_actual_clp: 561_728,
        total_facturado_clp: 561_728,
        cupo_en_cuotas_clp: 3_821_051,
        cuota_a_pagar_next_mes_clp: 561_728,
        balance_total_clp: 6_005_278,
      })],
      facturaciones
    );
    const jul = rows.find((r) => r.month === "2026-07");
    expect(jul?.installment_payments_clp).toBe(561_728);
    expect(jul?.facturado_clp).toBe(561_728);
  });

  it("extends past detalle with projected installment months from historial", () => {
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
    const hist = [
      { month: "2026-06", remaining_balance_clp: 5_000_000, installment_payments_clp: 200_000, ledger_remaining_installments_clp: 5_000_000 },
      { month: "2026-07", remaining_balance_clp: 4_500_000, installment_payments_clp: 180_000, ledger_remaining_installments_clp: 4_500_000 },
      { month: "2026-08", remaining_balance_clp: 4_200_000, installment_payments_clp: 300_000, ledger_remaining_installments_clp: 4_200_000 },
      { month: "2026-09", remaining_balance_clp: 3_900_000, installment_payments_clp: 300_000, ledger_remaining_installments_clp: 3_900_000 },
      { month: "2026-10", remaining_balance_clp: 0, installment_payments_clp: 300_000, ledger_remaining_installments_clp: 0 },
      { month: "2026-11", remaining_balance_clp: 0, installment_payments_clp: 0, ledger_remaining_installments_clp: 0 },
    ];
    const rows = buildCcHistorialChartSeries(hist, detalle, []);
    expect(rows.map((r) => r.month)).toEqual([
      "2026-06",
      "2026-07",
      "2026-08",
      "2026-09",
      "2026-10",
    ]);
    const aug = rows.find((r) => r.month === "2026-08");
    expect(aug).toMatchObject({
      installment_payments_clp: 300_000,
      cupo_en_cuotas_clp: 4_200_000,
      balance_total_clp: 4_200_000,
      facturado_clp: null,
    });
    expect(rows.find((r) => r.month === "2026-11")).toBeUndefined();
  });

  it("fills interior gap months in detalle with nulls/zeros", () => {
    // Detalle has Jul and Nov but not Aug/Sep/Oct — those are real import gaps
    const detalle = [
      makeDetalle("2025-07", { total_facturado_clp: 1_000_000, cupo_en_cuotas_clp: 500_000, balance_total_clp: 1_500_000 }),
      makeDetalle("2025-11", { total_facturado_clp: 2_000_000, cupo_en_cuotas_clp: 400_000, balance_total_clp: 2_400_000 }),
    ];
    const rows = buildCcHistorialChartSeries([], detalle, []);
    const months = rows.map((r) => r.month);
    expect(months).toEqual(["2025-07", "2025-08", "2025-09", "2025-10", "2025-11"]);
    // Existing months have their data
    expect(rows.find((r) => r.month === "2025-07")?.facturado_clp).toBe(1_000_000);
    expect(rows.find((r) => r.month === "2025-11")?.facturado_clp).toBe(2_000_000);
    // Gap months have nulls
    for (const ym of ["2025-08", "2025-09", "2025-10"]) {
      const row = rows.find((r) => r.month === ym);
      expect(row?.facturado_clp).toBeNull();
      expect(row?.cupo_en_cuotas_clp).toBeNull();
      expect(row?.balance_total_clp).toBeNull();
      expect(row?.installment_payments_clp).toBe(0);
    }
  });
});
