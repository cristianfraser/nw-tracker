/**
 * Schedule 1 (Additional Income and Adjustments to Income), Part I, the lines the draft fills
 * (docs/us-1040-readings.md §13): line 5 rental real estate (Schedule E, after Form 8582's passive
 * limit), line 8z other income (Form 8621 Part IV's mark-to-market inclusions and deductions:
 * «include the gain or (loss) on the "other income" line»), line 9 the total of line 8, line 10 =
 * 1–7 + 9 → Form 1040 line 8. Part II (adjustments, line 26 → 1040 line 10) has nothing on file: 0.
 * Pure; whole dollars. Schedule E, Form 8582 and Form 8621 are their own modules; until they are
 * wired their figures enter as typed inputs (`draft.ts` `F1040WiredInputs`).
 */

export type Schedule1Line = "5" | "8z" | "9" | "10" | "26";
export type Schedule1 = Record<Schedule1Line, number>;

export function schedule1(input: { rentalRealEstate: number; pficMarkToMarket: number; otherIncome: number }): Schedule1 {
  for (const [k, v] of Object.entries(input)) if (!Number.isInteger(v)) throw new Error(`Schedule 1: ${k} = ${v} is not whole dollars`);
  const l8z = input.pficMarkToMarket + input.otherIncome;
  return { "5": input.rentalRealEstate, "8z": l8z, "9": l8z, "10": input.rentalRealEstate + l8z, "26": 0 };
}
