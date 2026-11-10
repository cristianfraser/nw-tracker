/**
 * Schedule 2 (Additional Taxes), the lines the draft fills (docs/us-1040-readings.md §13): Part I
 * line 3 → Form 1040 line 17 (alternative minimum tax and excess premium-tax-credit repayment: not
 * modelled, 0); Part II line 11 the additional Medicare tax (Form 8959), line 12 the net investment
 * income tax (Form 8960), line 21 their total → Form 1040 line 23. Pure; whole dollars.
 */

export type Schedule2Line = "3" | "11" | "12" | "21";
export type Schedule2 = Record<Schedule2Line, number>;

export function schedule2(input: { additionalMedicareTax: number; netInvestmentIncomeTax: number }): Schedule2 {
  const l11 = input.additionalMedicareTax;
  const l12 = input.netInvestmentIncomeTax;
  if (!Number.isInteger(l11) || !Number.isInteger(l12)) throw new Error(`Schedule 2: lines 11 (${l11}) and 12 (${l12}) must be whole dollars`);
  return { "3": 0, "11": l11, "12": l12, "21": l11 + l12 };
}
