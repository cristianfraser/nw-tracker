import { describe, expect, it } from "vitest";
import {
  usIncomeTax,
  usMedicareTax,
  usPercentageMethodWithholding,
  usSocialSecurityTax,
  usSupplementalWithholding,
  usTaxYear,
} from "./usLegalParameters.js";

describe("US legal parameters", () => {
  it("the 1040's tax on a known income, per year", () => {
    // IRS tax tables: $100.000 of taxable income, single.
    expect(usIncomeTax(100_000, "single", 2024)).toBeCloseTo(17_053, 6);
    expect(usIncomeTax(100_000, "single", 2025)).toBeCloseTo(16_914, 6);
    expect(usIncomeTax(100_000, "single", 2026)).toBeCloseTo(16_712, 6);
    expect(usIncomeTax(200_000, "married_jointly", 2024)).toBeCloseTo(34_106, 6);
    expect(usIncomeTax(0, "single", 2026)).toBe(0);
    expect(usIncomeTax(1_000_000, "single", 2026)).toBeCloseTo(
      1_240 + 4_560 + 0.22 * (105_700 - 50_400) + 0.24 * (201_775 - 105_700) + 0.32 * (256_225 - 201_775) + 0.35 * (640_600 - 256_225) + 0.37 * (1_000_000 - 640_600),
      6
    );
  });

  it("a year it does not list throws", () => {
    expect(() => usTaxYear(2023)).toThrow(/no figures for 2023/);
    expect(() => usIncomeTax(50_000, "single", 2027)).toThrow(/no figures for 2027/);
  });

  it("Pub. 15-T's percentage method: the brackets shifted by the withholding standard deduction less line 1g", () => {
    // 2024, single, biweekly $2.000: 52.000 − 8.600 − 6.000 = 37.400 → 1.160 + 12 % × 25.800 = 4.256 a year.
    expect(usPercentageMethodWithholding(2_000, "biweekly", "single", 2024)).toBe(163.69);
    // 2026, single, biweekly $3.575: 92.950 − 8.600 − 7.500 = 76.850 → 11.619 a year.
    expect(usPercentageMethodWithholding(3_575, "biweekly", "single", 2026)).toBe(446.88);
    // 2025 withholds on the tables as published (standard deduction 15.000), not the OBBBA's 15.750.
    // Semi-monthly $3.000: 72.000 − 8.600 − 6.400 = 57.000 → 1.192,50 + 4.386 + 22 % × 8.525 = 7.454 a year.
    expect(usPercentageMethodWithholding(3_000, "semi_monthly", "single", 2025)).toBe(310.58);
    expect(usPercentageMethodWithholding(500, "biweekly", "married_jointly", 2026)).toBe(0);
  });

  it("FICA respects the employer's year to date", () => {
    expect(usSocialSecurityTax(3_815, 0, 2026)).toBe(236.53);
    // Only 4.500 left under the 2026 wage base of 184.500.
    expect(usSocialSecurityTax(10_000, 180_000, 2026)).toBe(279);
    expect(usSocialSecurityTax(10_000, 190_000, 2026)).toBe(0);
    expect(usMedicareTax(3_815, 0, 2026)).toBe(55.32);
    // 5.000 of the payment is above the $200.000 withholding threshold.
    expect(usMedicareTax(10_000, 195_000, 2026)).toBe(190);
    expect(usMedicareTax(10_000, 210_000, 2026)).toBe(235);
  });

  it("supplemental wages at the flat 22 %, 37 % above $1M", () => {
    expect(usSupplementalWithholding(10_000, 0, 2026)).toBe(2_200);
    expect(usSupplementalWithholding(10_000, 995_000, 2026)).toBe(5_000 * 0.22 + 5_000 * 0.37);
  });
});
