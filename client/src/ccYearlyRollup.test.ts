import { describe, expect, it } from "vitest";
import { rollupCcBillingDetailYearly, rollupCcHistorialChartYearly } from "./ccYearlyRollup";
import type { CcBillingDetailMonthDto, CcHistorialChartPoint } from "./types";

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

function historialRow(overrides: Partial<CcHistorialChartPoint>): CcHistorialChartPoint {
  return {
    month: "2026-01",
    facturado_cuotas_clp: null,
    facturado_rest_clp: null,
    facturado_usd_clp: null,
    facturado_usd: null,
    facturado_total_clp: null,
    cupo_en_cuotas_clp: null,
    balance_total_clp: null,
    ...overrides,
  };
}

describe("rollupCcHistorialChartYearly", () => {
  it("sums each bar segment (projected months included) and takes lines from the year's last known month", () => {
    const rows: CcHistorialChartPoint[] = [
      historialRow({
        month: "2026-06",
        facturado_cuotas_clp: 50_000,
        facturado_rest_clp: 230_000,
        facturado_usd_clp: 20_000,
        facturado_usd: 21.5,
        facturado_total_clp: 300_000,
        cupo_en_cuotas_clp: 400_000,
        balance_total_clp: 650_000,
      }),
      historialRow({
        month: "2026-07",
        facturado_cuotas_clp: 80_000,
        facturado_rest_clp: 10_000,
        facturado_total_clp: 90_000,
        cupo_en_cuotas_clp: 350_000,
        balance_total_clp: 600_000,
      }),
      // Projected tail month: the plan's cuotas only
      historialRow({
        month: "2026-12",
        facturado_cuotas_clp: 60_000,
        facturado_total_clp: 60_000,
        cupo_en_cuotas_clp: 100_000,
        balance_total_clp: 100_000,
      }),
    ];
    const [year] = rollupCcHistorialChartYearly(rows);
    expect(year).toEqual({
      month: "2026-12",
      facturado_cuotas_clp: 190_000,
      facturado_rest_clp: 240_000,
      facturado_usd_clp: 20_000,
      facturado_usd: 21.5,
      facturado_total_clp: 450_000,
      cupo_en_cuotas_clp: 100_000,
      balance_total_clp: 100_000,
    });
  });

  it("skips trailing null line values when picking the year-end stock", () => {
    const rows: CcHistorialChartPoint[] = [
      historialRow({
        month: "2024-10",
        facturado_cuotas_clp: 10_000,
        facturado_rest_clp: 10_000,
        facturado_total_clp: 20_000,
        cupo_en_cuotas_clp: 90_000,
        balance_total_clp: 95_000,
      }),
      historialRow({ month: "2024-11" }),
    ];
    const [year] = rollupCcHistorialChartYearly(rows);
    expect(year.cupo_en_cuotas_clp).toBe(90_000);
    expect(year.balance_total_clp).toBe(95_000);
  });

  it("keeps an all-null gap year's bar null", () => {
    const [year] = rollupCcHistorialChartYearly([historialRow({ month: "2023-04" })]);
    expect(year).toMatchObject({ month: "2023-12", facturado_cuotas_clp: null, facturado_total_clp: null });
  });
});
