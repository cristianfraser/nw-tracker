import { describe, expect, it } from "vitest";
import {
  rollupCcBillingDetailYearly,
  rollupCcBillingMonthChartYearly,
  rollupCcHistorialChartYearly,
} from "./ccYearlyRollup";
import type {
  CcBillingDetailMonthDto,
  CcBillingMonthChartPoint,
  CcHistorialChartPoint,
} from "./types";

function detalleRow(overrides: Partial<CcBillingDetailMonthDto>): CcBillingDetailMonthDto {
  return {
    billing_month: "2025-01",
    as_of_date: "2025-01-20",
    as_of_kind: "statement",
    total_facturado_actual_clp: null,
    total_facturado_clp: null,
    cupo_en_cuotas_clp: 0,
    cuota_a_pagar_next_mes_clp: 0,
    balance_total_clp: 0,
    ...overrides,
  };
}

describe("rollupCcBillingDetailYearly", () => {
  it("sums a fully closed year and takes stocks from the latest month", () => {
    const rows = [
      detalleRow({
        billing_month: "2024-11",
        as_of_date: "2024-11-20",
        total_facturado_clp: 100_000,
        total_facturado_actual_clp: 90_000,
        cupo_en_cuotas_clp: 500_000,
        balance_total_clp: 550_000,
        cuota_a_pagar_next_mes_clp: 40_000,
      }),
      detalleRow({
        billing_month: "2024-12",
        as_of_date: "2024-12-20",
        total_facturado_clp: 200_000,
        total_facturado_actual_clp: 180_000,
        cupo_en_cuotas_clp: 450_000,
        balance_total_clp: 600_000,
        cuota_a_pagar_next_mes_clp: 40_000,
      }),
    ];
    const [year] = rollupCcBillingDetailYearly(rows);
    expect(year).toMatchObject({
      billing_month: "2024-12",
      as_of_date: "2024-12-20",
      as_of_kind: "statement",
      total_facturado_clp: 300_000,
      total_facturado_actual_clp: 270_000,
      cupo_en_cuotas_clp: 450_000,
      balance_total_clp: 600_000,
      projected: false,
    });
  });

  it("mixed closed/open/projected year: null facturado with full-year estimate, stocks from December, not projected", () => {
    const rows = [
      detalleRow({
        billing_month: "2026-06",
        as_of_date: "2026-06-20",
        total_facturado_clp: 300_000,
        cuota_a_pagar_next_mes_clp: 50_000,
        cupo_en_cuotas_clp: 400_000,
        balance_total_clp: 650_000,
      }),
      // Open month: no statement close yet → facturado null, ≈ cuota a pagar
      detalleRow({
        billing_month: "2026-07",
        as_of_date: "2026-07-15",
        as_of_kind: "manual",
        total_facturado_clp: null,
        cuota_a_pagar_next_mes_clp: 80_000,
        cupo_en_cuotas_clp: 350_000,
        balance_total_clp: 600_000,
      }),
      // Projected plan month at year-end
      detalleRow({
        billing_month: "2026-12",
        as_of_date: "2026-12-01",
        as_of_kind: "manual",
        total_facturado_clp: null,
        cuota_a_pagar_next_mes_clp: 60_000,
        cupo_en_cuotas_clp: 100_000,
        balance_total_clp: 100_000,
        projected: true,
      }),
    ];
    const [year] = rollupCcBillingDetailYearly(rows);
    expect(year).toMatchObject({
      billing_month: "2026-12",
      as_of_date: "2026-12-01",
      as_of_kind: "manual",
      total_facturado_clp: null,
      // closed 300k + open 80k + projected 60k
      cuota_a_pagar_next_mes_clp: 440_000,
      cupo_en_cuotas_clp: 100_000,
      balance_total_clp: 100_000,
      projected: false,
    });
  });

  it("plan-only future year is projected with a pure cuota estimate", () => {
    const rows = [
      detalleRow({
        billing_month: "2027-01",
        as_of_date: "2027-01-01",
        as_of_kind: "manual",
        cuota_a_pagar_next_mes_clp: 60_000,
        cupo_en_cuotas_clp: 40_000,
        balance_total_clp: 40_000,
        projected: true,
      }),
      detalleRow({
        billing_month: "2027-02",
        as_of_date: "2027-02-01",
        as_of_kind: "manual",
        cuota_a_pagar_next_mes_clp: 40_000,
        cupo_en_cuotas_clp: 0,
        balance_total_clp: 0,
        projected: true,
      }),
    ];
    const [year] = rollupCcBillingDetailYearly(rows);
    expect(year).toMatchObject({
      billing_month: "2027-12",
      total_facturado_clp: null,
      cuota_a_pagar_next_mes_clp: 100_000,
      cupo_en_cuotas_clp: 0,
      balance_total_clp: 0,
      projected: true,
    });
  });

  it("returns years ascending regardless of input order", () => {
    const rows = [
      detalleRow({ billing_month: "2026-01", total_facturado_clp: 1 }),
      detalleRow({ billing_month: "2024-05", total_facturado_clp: 2 }),
      detalleRow({ billing_month: "2025-03", total_facturado_clp: 3 }),
    ];
    expect(rollupCcBillingDetailYearly(rows).map((r) => r.billing_month)).toEqual([
      "2024-12",
      "2025-12",
      "2026-12",
    ]);
  });
});

describe("rollupCcHistorialChartYearly", () => {
  it("sums bars (projected months included) and takes lines from the year's last known month", () => {
    const rows: CcHistorialChartPoint[] = [
      {
        month: "2026-06",
        installment_payments_clp: 50_000,
        facturado_clp: 300_000,
        cupo_en_cuotas_clp: 400_000,
        balance_total_clp: 650_000,
      },
      {
        month: "2026-07",
        installment_payments_clp: 80_000,
        facturado_clp: null,
        cupo_en_cuotas_clp: 350_000,
        balance_total_clp: 600_000,
      },
      // Projected tail month: plan cuota, no facturado
      {
        month: "2026-12",
        installment_payments_clp: 60_000,
        facturado_clp: null,
        cupo_en_cuotas_clp: 100_000,
        balance_total_clp: 100_000,
      },
    ];
    const [year] = rollupCcHistorialChartYearly(rows);
    expect(year).toEqual({
      month: "2026-12",
      installment_payments_clp: 190_000,
      facturado_clp: 300_000,
      cupo_en_cuotas_clp: 100_000,
      balance_total_clp: 100_000,
    });
  });

  it("skips trailing null line values when picking the year-end stock", () => {
    const rows: CcHistorialChartPoint[] = [
      {
        month: "2024-10",
        installment_payments_clp: 10_000,
        facturado_clp: 20_000,
        cupo_en_cuotas_clp: 90_000,
        balance_total_clp: 95_000,
      },
      {
        month: "2024-11",
        installment_payments_clp: 0,
        facturado_clp: null,
        cupo_en_cuotas_clp: null,
        balance_total_clp: null,
      },
    ];
    const [year] = rollupCcHistorialChartYearly(rows);
    expect(year.cupo_en_cuotas_clp).toBe(90_000);
    expect(year.balance_total_clp).toBe(95_000);
  });
});

describe("rollupCcBillingMonthChartYearly", () => {
  it("sums the flow bars and drops the YTD series", () => {
    const points: CcBillingMonthChartPoint[] = [
      {
        billing_month: "2025-11",
        facturado_clp: 100_000,
        facturado_usd_clp: 10_000,
        financing_cost_clp: 5_000,
        ytd_financing_cost_clp: 40_000,
      },
      {
        billing_month: "2025-12",
        facturado_clp: 200_000,
        facturado_usd_clp: null,
        financing_cost_clp: 7_000,
        ytd_financing_cost_clp: 47_000,
      },
    ];
    const [year] = rollupCcBillingMonthChartYearly(points);
    expect(year).toEqual({
      billing_month: "2025-12",
      facturado_clp: 300_000,
      facturado_usd_clp: 10_000,
      financing_cost_clp: 12_000,
      ytd_financing_cost_clp: null,
    });
  });

  it("keeps an all-null gap year null", () => {
    const points: CcBillingMonthChartPoint[] = [
      {
        billing_month: "2023-04",
        facturado_clp: null,
        facturado_usd_clp: null,
        financing_cost_clp: null,
        ytd_financing_cost_clp: null,
      },
    ];
    const [year] = rollupCcBillingMonthChartYearly(points);
    expect(year).toEqual({
      billing_month: "2023-12",
      facturado_clp: null,
      facturado_usd_clp: null,
      financing_cost_clp: null,
      ytd_financing_cost_clp: null,
    });
  });
});
