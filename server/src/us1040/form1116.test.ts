import { describe, expect, it } from "vitest";
import { classifyChileanTaxes, form1116 } from "./form1116.js";

const base = {
  taxYear: 2025,
  foreignPassiveGrossUsd: 12_000,
  foreignPassiveDeductionsUsd: 10_000,
  taxableIncomeUsd: 100_000,
  usTaxBeforeCreditsUsd: 18_000,
  carryoversIn: [],
};

describe("Form 1116 passive limit", () => {
  it("credits the whole tax when it is below the limit", () => {
    // 2.000 ÷ 100.000 × 18.000 = 360.
    const r = form1116({ ...base, taxesAccruedUsd: 300 });
    expect(r.limitFraction).toBeCloseTo(0.02, 12);
    expect(r.limitUsd).toBeCloseTo(360, 9);
    expect(r.creditAllowedUsd).toBe(300);
    expect(r.carryoversOut).toEqual([]);
  });

  it("allows exactly the limit at the limit and carries the excess above it", () => {
    expect(form1116({ ...base, taxesAccruedUsd: 360 }).creditAllowedUsd).toBeCloseTo(360, 9);
    const r = form1116({ ...base, taxesAccruedUsd: 1_000 });
    expect(r.creditAllowedUsd).toBeCloseTo(360, 9);
    expect(r.carryoversOut).toHaveLength(1);
    expect(r.carryoversOut[0]!.taxYear).toBe(2025);
    expect(r.carryoversOut[0]!.amountUsd).toBeCloseTo(640, 9);
  });

  it("allows nothing when the category has no positive net income (a rental loss) and carries everything", () => {
    const r = form1116({ ...base, foreignPassiveDeductionsUsd: 13_000, taxesAccruedUsd: 500 });
    expect(r.limitFraction).toBe(0);
    expect(r.creditAllowedUsd).toBe(0);
    expect(r.carryoversOut).toEqual([{ taxYear: 2025, amountUsd: 500 }]);
  });

  it("caps the fraction at one", () => {
    const r = form1116({ ...base, foreignPassiveGrossUsd: 200_000, taxesAccruedUsd: 99_999 });
    expect(r.limitFraction).toBe(1);
    expect(r.creditAllowedUsd).toBe(18_000);
  });

  it("uses the current year's taxes before the carryovers (oldest first) and drops the ones past ten years", () => {
    const r = form1116({
      ...base,
      taxYear: 2036,
      foreignPassiveGrossUsd: 30_000,
      taxesAccruedUsd: 1_000,
      carryoversIn: [
        { taxYear: 2025, amountUsd: 900 }, // 11 years: expired
        { taxYear: 2030, amountUsd: 700 },
        { taxYear: 2033, amountUsd: 800 },
      ],
    });
    // Limit 20.000 ÷ 100.000 × 18.000 = 3.600: 1.000 + 700 + 800 all fit.
    expect(r.expiredUsd).toBe(900);
    expect(r.creditAllowedUsd).toBe(2_500);
    const tight = form1116({ ...base, taxYear: 2036, foreignPassiveGrossUsd: 12_000 + 3_000, taxesAccruedUsd: 100, carryoversIn: [{ taxYear: 2033, amountUsd: 800 }, { taxYear: 2030, amountUsd: 700 }] });
    // Limit 5.000 ÷ 100.000 × 18.000 = 900: current 100, then 2030's 700, then 100 of 2033's.
    expect(tight.creditAllowedUsd).toBeCloseTo(900, 9);
    expect(tight.carryoversOut).toEqual([{ taxYear: 2033, amountUsd: expect.closeTo(700, 9) }]);
  });
});

describe("Chilean taxes on Form 1116", () => {
  it("credits the Adicional on rent, never the único on a sale, and flags what is unverified", () => {
    const r = classifyChileanTaxes([
      { item: "adicional_on_rent", amountUsd: 4_000 },
      { item: "unico_on_etf_sale", amountUsd: 150 },
      { item: "unico_on_fund_redemption", amountUsd: 80 },
      { item: "unico_on_fund_distribution", amountUsd: 20 },
    ]);
    expect(r.creditableUsd).toBe(4_020);
    expect(r.classified.map((c) => [c.item, c.creditable, c.unverified, c.form8833])).toEqual([
      ["adicional_on_rent", true, false, true],
      ["unico_on_etf_sale", false, false, false],
      ["unico_on_fund_redemption", false, false, false],
      ["unico_on_fund_distribution", true, true, false],
    ]);
  });
});
