import { describe, expect, it } from "vitest";
import { rollupCcBillingDetailYearly, rollupCcHistorialChartYearly } from "./ccYearlyRollup";
import type { CcBillingDetailMonthDto, CcHistorialChartPoint } from "./types";

function detalleRow(overrides: Partial<CcBillingDetailMonthDto>): CcBillingDetailMonthDto {
  return {
    billing_month: "2025-01",
    as_of_date: "2025-01-20",
    as_of_kind: "statement",
    total_facturado_actual: null,
    total_facturado: null,
    cupo_en_cuotas: 0,
    cuota_a_pagar_next_mes: 0,
    balance_total: 0,
    cupo_statement: 0,
    balance_statement: 0,
    ...overrides,
  };
}

describe("rollupCcBillingDetailYearly", () => {
  it("sums a fully closed year and takes stocks from the latest month", () => {
    const rows = [
      detalleRow({
        billing_month: "2024-11",
        as_of_date: "2024-11-20",
        total_facturado: 100_000,
        total_facturado_actual: 90_000,
        cupo_en_cuotas: 500_000,
        balance_total: 550_000,
        cuota_a_pagar_next_mes: 40_000,
      }),
      detalleRow({
        billing_month: "2024-12",
        as_of_date: "2024-12-20",
        total_facturado: 200_000,
        total_facturado_actual: 180_000,
        cupo_en_cuotas: 450_000,
        balance_total: 600_000,
        cuota_a_pagar_next_mes: 40_000,
      }),
    ];
    const [year] = rollupCcBillingDetailYearly(rows);
    expect(year).toMatchObject({
      billing_month: "2024-12",
      as_of_date: "2024-12-20",
      as_of_kind: "statement",
      total_facturado: 300_000,
      total_facturado_actual: 270_000,
      cupo_en_cuotas: 450_000,
      balance_total: 600_000,
      projected: false,
    });
  });

  it("mixed closed/open/projected year: null facturado with full-year estimate, stocks from December, not projected", () => {
    const rows = [
      detalleRow({
        billing_month: "2026-06",
        as_of_date: "2026-06-20",
        total_facturado: 300_000,
        cuota_a_pagar_next_mes: 50_000,
        cupo_en_cuotas: 400_000,
        balance_total: 650_000,
      }),
      // Open month: no statement close yet → facturado null, ≈ cuota a pagar
      detalleRow({
        billing_month: "2026-07",
        as_of_date: "2026-07-15",
        as_of_kind: "manual",
        total_facturado: null,
        cuota_a_pagar_next_mes: 80_000,
        cupo_en_cuotas: 350_000,
        balance_total: 600_000,
      }),
      // Projected plan month at year-end
      detalleRow({
        billing_month: "2026-12",
        as_of_date: "2026-12-01",
        as_of_kind: "manual",
        total_facturado: null,
        cuota_a_pagar_next_mes: 60_000,
        cupo_en_cuotas: 100_000,
        balance_total: 100_000,
        projected: true,
      }),
    ];
    const [year] = rollupCcBillingDetailYearly(rows);
    expect(year).toMatchObject({
      billing_month: "2026-12",
      as_of_date: "2026-12-01",
      as_of_kind: "manual",
      total_facturado: null,
      // closed 300k + open 80k + projected 60k
      cuota_a_pagar_next_mes: 440_000,
      cupo_en_cuotas: 100_000,
      balance_total: 100_000,
      projected: false,
    });
  });

  it("plan-only future year is projected with a pure cuota estimate", () => {
    const rows = [
      detalleRow({
        billing_month: "2027-01",
        as_of_date: "2027-01-01",
        as_of_kind: "manual",
        cuota_a_pagar_next_mes: 60_000,
        cupo_en_cuotas: 40_000,
        balance_total: 40_000,
        projected: true,
      }),
      detalleRow({
        billing_month: "2027-02",
        as_of_date: "2027-02-01",
        as_of_kind: "manual",
        cuota_a_pagar_next_mes: 40_000,
        cupo_en_cuotas: 0,
        balance_total: 0,
        projected: true,
      }),
    ];
    const [year] = rollupCcBillingDetailYearly(rows);
    expect(year).toMatchObject({
      billing_month: "2027-12",
      total_facturado: null,
      cuota_a_pagar_next_mes: 100_000,
      cupo_en_cuotas: 0,
      balance_total: 0,
      projected: true,
    });
  });

  it("month-frame lines take the last month with a point; the statement frame the latest month", () => {
    const rows = [
      detalleRow({
        billing_month: "2026-10",
        cupo_en_cuotas: 300_000,
        balance_total: 450_000,
        cupo_statement: 310_000,
        balance_statement: 460_000,
      }),
      detalleRow({
        billing_month: "2026-11",
        cupo_en_cuotas: null,
        balance_total: null,
        cupo_statement: 250_000,
        balance_statement: 250_000,
        projected: true,
      }),
    ];
    const [year] = rollupCcBillingDetailYearly(rows);
    expect(year).toMatchObject({
      cupo_en_cuotas: 300_000,
      balance_total: 450_000,
      cupo_statement: 250_000,
      balance_statement: 250_000,
    });
  });

  it("a year whose every month lacks a chart point rolls up to null lines", () => {
    const rows = [detalleRow({ billing_month: "2027-01", cupo_en_cuotas: null, balance_total: null })];
    const [year] = rollupCcBillingDetailYearly(rows);
    expect(year!.cupo_en_cuotas).toBeNull();
    expect(year!.balance_total).toBeNull();
  });

  it("returns years ascending regardless of input order", () => {
    const rows = [
      detalleRow({ billing_month: "2026-01", total_facturado: 1 }),
      detalleRow({ billing_month: "2024-05", total_facturado: 2 }),
      detalleRow({ billing_month: "2025-03", total_facturado: 3 }),
    ];
    expect(rollupCcBillingDetailYearly(rows).map((r) => r.billing_month)).toEqual([
      "2024-12",
      "2025-12",
      "2026-12",
    ]);
  });
});

function historialRow(overrides: Partial<CcHistorialChartPoint>): CcHistorialChartPoint {
  return {
    month: "2026-01",
    facturado_cuotas: null,
    facturado_rest: null,
    facturado_foreign_total: null,
    facturado_foreign: null,
    facturado_total: null,
    cupo_en_cuotas: null,
    balance_total: null,
    ...overrides,
  };
}

describe("rollupCcHistorialChartYearly", () => {
  it("sums each bar segment (projected months included) and takes lines from the year's last known month", () => {
    const rows: CcHistorialChartPoint[] = [
      historialRow({
        month: "2026-06",
        facturado_cuotas: 50_000,
        facturado_rest: 230_000,
        facturado_foreign_total: 20_000,
        facturado_foreign: [{ currency: "usd", amount: 21.5 }],
        facturado_total: 300_000,
        cupo_en_cuotas: 400_000,
        balance_total: 650_000,
      }),
      historialRow({
        month: "2026-07",
        facturado_cuotas: 80_000,
        facturado_rest: 10_000,
        facturado_total: 90_000,
        cupo_en_cuotas: 350_000,
        balance_total: 600_000,
      }),
      // Projected tail month: the plan's cuotas only
      historialRow({
        month: "2026-12",
        facturado_cuotas: 60_000,
        facturado_total: 60_000,
        cupo_en_cuotas: 100_000,
        balance_total: 100_000,
      }),
    ];
    const [year] = rollupCcHistorialChartYearly(rows);
    expect(year).toEqual({
      month: "2026-12",
      facturado_cuotas: 190_000,
      facturado_rest: 240_000,
      facturado_foreign_total: 20_000,
      facturado_foreign: [{ currency: "usd", amount: 21.5 }],
      facturado_total: 450_000,
      cupo_en_cuotas: 100_000,
      balance_total: 100_000,
    });
  });

  it("skips trailing null line values when picking the year-end stock", () => {
    const rows: CcHistorialChartPoint[] = [
      historialRow({
        month: "2024-10",
        facturado_cuotas: 10_000,
        facturado_rest: 10_000,
        facturado_total: 20_000,
        cupo_en_cuotas: 90_000,
        balance_total: 95_000,
      }),
      historialRow({ month: "2024-11" }),
    ];
    const [year] = rollupCcHistorialChartYearly(rows);
    expect(year.cupo_en_cuotas).toBe(90_000);
    expect(year.balance_total).toBe(95_000);
  });

  it("keeps an all-null gap year's bar null", () => {
    const [year] = rollupCcHistorialChartYearly([historialRow({ month: "2023-04" })]);
    expect(year).toMatchObject({ month: "2023-12", facturado_cuotas: null, facturado_total: null });
  });
});
