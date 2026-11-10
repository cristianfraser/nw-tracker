/**
 * Form 8960 (Net Investment Income Tax, §1411; docs/us-1040-readings.md §10). Pure; whole dollars.
 *
 *    1 taxable interest (1040 line 2b)        2 ordinary dividends (3b)       3 annuities (0)
 *   4a rental real estate, royalties … (Schedule E; a typed input until Schedule E is wired)
 *   4c = 4a (4b's non-NII adjustment not modelled)
 *   5a net gain from the disposition of property (1040 line 7) plus the §1296 mark-to-market
 *      inclusions, which Reg. §1.1411-10 takes «into account in determining net gain» (typed input)
 *   5d = 5a (5b/5c adjustments not modelled)     7 other modifications (0)
 *    8 = 1 + 2 + 3 + 4c + 5d + 7                 11 deductions allocable to NII (0, not modelled)
 *   12 = max(0, 8 − 11)                          13 MAGI (1040 line 11; no foreign-earned exclusion)
 *   14 the threshold by filing status (single US$200.000; §1411(b), not indexed, not prorated in a
 *      dual-status year — «The relevant threshold amount isn't reduced or prorated»)
 *   15 = max(0, 13 − 14)                         16 = min(12, 15)
 *   17 = 16 × 3,8 % → Schedule 2 line 12
 *
 * Wages are not NII but count in MAGI. No foreign tax credit applies against this tax (Reg.
 * §1.1411-1(e)). A dual-status return computes it on the resident part only (the 1040's lines are
 * the resident part's).
 */

export type Form8960Line = "1" | "2" | "3" | "4a" | "4c" | "5a" | "5d" | "7" | "8" | "11" | "12" | "13" | "14" | "15" | "16" | "17";
export type Form8960 = Record<Form8960Line, number>;

export function form8960(input: {
  taxableInterest: number;
  ordinaryDividends: number;
  /** Schedule E net rental income counted as NII (0 until wired). */
  rentalNet: number;
  /** 1040 line 7. */
  capitalGain: number;
  /** §1296 inclusions (+) / deductions (−) (0 until wired). */
  pficInclusions: number;
  /** Any other NII (0 until wired). */
  other: number;
  magi: number;
  threshold: number;
  rate: number;
}): Form8960 {
  for (const [k, v] of Object.entries(input)) {
    if (k !== "rate" && !Number.isInteger(v)) throw new Error(`Form 8960: ${k} = ${v} is not whole dollars`);
  }
  const l4c = input.rentalNet;
  const l5a = input.capitalGain + input.pficInclusions;
  const l5d = l5a;
  const l8 = input.taxableInterest + input.ordinaryDividends + 0 + l4c + l5d + input.other;
  const l12 = Math.max(0, l8);
  const l15 = Math.max(0, input.magi - input.threshold);
  const l16 = Math.min(l12, l15);
  return {
    "1": input.taxableInterest,
    "2": input.ordinaryDividends,
    "3": 0,
    "4a": input.rentalNet,
    "4c": l4c,
    "5a": l5a,
    "5d": l5d,
    "7": input.other,
    "8": l8,
    "11": 0,
    "12": l12,
    "13": input.magi,
    "14": input.threshold,
    "15": l15,
    "16": l16,
    "17": Math.round(l16 * input.rate),
  };
}
