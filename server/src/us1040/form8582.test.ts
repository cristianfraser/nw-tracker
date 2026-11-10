import { describe, expect, it } from "vitest";
import { form8582, passiveLossAllowanceUsd } from "./form8582.js";

describe("Form 8582 special allowance", () => {
  it("phases out by half the MAGI over 100.000 and is gone at 150.000", () => {
    expect(passiveLossAllowanceUsd("single", 90_000).after).toBe(25_000);
    expect(passiveLossAllowanceUsd("single", 100_000).after).toBe(25_000);
    expect(passiveLossAllowanceUsd("single", 120_000).after).toBe(15_000);
    expect(passiveLossAllowanceUsd("married_jointly", 149_000).after).toBe(500);
    expect(passiveLossAllowanceUsd("single", 150_000).after).toBe(0);
    expect(passiveLossAllowanceUsd("single", 200_000).after).toBe(0);
  });

  it("halves both amounts for a married person filing separately who lived apart", () => {
    expect(passiveLossAllowanceUsd("married_separate_lived_apart", 50_000).after).toBe(12_500);
    expect(passiveLossAllowanceUsd("married_separate_lived_apart", 60_000).after).toBe(7_500);
    expect(passiveLossAllowanceUsd("married_separate_lived_apart", 75_000).after).toBe(0);
  });
});

describe("Form 8582", () => {
  it("allows a loss inside the allowance and suspends the rest", () => {
    const low = form8582({ status: "single", magiUsd: 90_000, rentalNetUsd: -10_000, priorSuspendedLossUsd: 0 });
    expect(low).toMatchObject({ allowedLossUsd: 10_000, suspendedLossUsd: 0, includedInIncomeUsd: -10_000 });
    const mid = form8582({ status: "single", magiUsd: 120_000, rentalNetUsd: -20_000, priorSuspendedLossUsd: 0 });
    expect(mid).toMatchObject({ allowanceUsd: 15_000, allowedLossUsd: 15_000, suspendedLossUsd: 5_000, includedInIncomeUsd: -15_000 });
    const high = form8582({ status: "single", magiUsd: 160_000, rentalNetUsd: -2_250, priorSuspendedLossUsd: 0 });
    expect(high).toMatchObject({ allowedLossUsd: 0, suspendedLossUsd: 2_250, includedInIncomeUsd: 0 });
  });

  it("adds the carried loss to the year's and releases it against a net gain first", () => {
    // Carried 2.250 + a new 1.000 loss at a MAGI that leaves 3.000: all allowed.
    expect(form8582({ status: "single", magiUsd: 144_000, rentalNetUsd: -1_000, priorSuspendedLossUsd: 2_250 })).toMatchObject({ limitedLossUsd: 3_250, allowedLossUsd: 3_000, suspendedLossUsd: 250 });
    // A gain of 1.500 absorbs 1.500 of the 2.250 carried; 750 stays suspended with a zero allowance.
    expect(form8582({ status: "single", magiUsd: 170_000, rentalNetUsd: 1_500, priorSuspendedLossUsd: 2_250 })).toMatchObject({
      priorLossAbsorbedUsd: 1_500,
      limitedLossUsd: 750,
      suspendedLossUsd: 750,
      includedInIncomeUsd: 0,
    });
    // A gain above the carry absorbs all of it.
    expect(form8582({ status: "single", magiUsd: 170_000, rentalNetUsd: 5_000, priorSuspendedLossUsd: 2_250 })).toMatchObject({ priorLossAbsorbedUsd: 2_250, suspendedLossUsd: 0, includedInIncomeUsd: 2_750 });
  });

  it("refuses a negative carry", () => {
    expect(() => form8582({ status: "single", magiUsd: 0, rentalNetUsd: 0, priorSuspendedLossUsd: -1 })).toThrow(/positive/);
  });
});
