import { describe, expect, it } from "vitest";
import { monthTaxablePay } from "./payrollTaxYear.js";

const row = {
  period_month: "2030-01",
  total_haberes_clp: 4_000_000,
  total_imponible_clp: 3_500_000,
  total_no_imponible_clp: 80_000,
  colacion_clp: 60_000,
  movilizacion_clp: 20_000,
  desc_afp_clp: 370_000,
  desc_health_clp: 245_000,
  desc_cesantia_clp: 21_000,
  desc_tax_clp: 140_000,
};

describe("monthTaxablePay", () => {
  it("is haberes less the non-taxable allowances and the worker's contributions", () => {
    expect(monthTaxablePay(row)).toBe(4_000_000 - 80_000 - 370_000 - 245_000 - 21_000);
  });

  it("deducts health only up to the legal 7% of the taxable base", () => {
    // A pactado isapre above 7%: 300.000 printed, 245.000 deductible.
    expect(monthTaxablePay({ ...row, desc_health_clp: 300_000 })).toBe(4_000_000 - 80_000 - 370_000 - 245_000 - 21_000);
  });

  it("uses the allowances when the non-taxable total is not printed, and taxable + non-taxable when haberes is not", () => {
    expect(monthTaxablePay({ ...row, total_no_imponible_clp: null })).toBe(4_000_000 - 80_000 - 370_000 - 245_000 - 21_000);
    expect(monthTaxablePay({ ...row, total_haberes_clp: null })).toBe(3_580_000 - 80_000 - 370_000 - 245_000 - 21_000);
    expect(monthTaxablePay({ ...row, total_haberes_clp: null, total_no_imponible_clp: null })).toBeNull();
  });
});
