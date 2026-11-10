/**
 * The Qualified Dividends and Capital Gain Tax Worksheet — Line 16 of the Form 1040 instructions
 * (2024 and 2025 editions; docs/us-1040-readings.md §9): qualified dividends and net long-term gain
 * taxed at 0 / 15 / 20 % on top of the ordinary income, the line-16 tax the smaller of that and the
 * ordinary tax on all of it. Pure: the ordinary tax (`taxOn`, the Tax Table / Tax Computation
 * Worksheet) and the year's edges are inputs.
 *
 *    1 taxable income (1040 line 15)        2 qualified dividends (3a)
 *    3 Schedule D: smaller of its lines 15 and 16 (0 if either is a loss); else 1040 line 7
 *    4 = 2 + 3                              5 = max(0, 1 − 4)            (the ordinary part)
 *    6 the 0 % edge                         7 = min(1, 6)                8 = min(5, 7)
 *    9 = 7 − 8                                                           (taxed at 0 %)
 *   10 = min(1, 4)                         11 = 9                       12 = 10 − 11
 *   13 the 15 % edge                       14 = min(1, 13)              15 = 5 + 9
 *   16 = max(0, 14 − 15)                   17 = min(12, 16)             18 = 17 × 15 %
 *   19 = 9 + 17                            20 = 10 − 19                 21 = 20 × 20 %
 *   22 tax on line 5                       23 = 18 + 21 + 22            24 tax on line 1
 *   25 = min(23, 24) → Form 1040 line 16
 *
 * Lines 18 and 21 are kept to the cent and 23 is rounded to the dollar (the form's whole-dollar
 * convention on its totals).
 */

export type QdcgWorksheetLine =
  | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "10" | "11" | "12" | "13" | "14" | "15" | "16" | "17" | "18"
  | "19" | "20" | "21" | "22" | "23" | "24" | "25";
export type QdcgWorksheet = Record<QdcgWorksheetLine, number>;

export function qualifiedDividendsWorksheet(input: {
  taxableIncome: number;
  qualifiedDividends: number;
  /** Line 3: `scheduleDNetCapitalGainForWorksheet` (or 1040 line 7 without a Schedule D), never negative. */
  netCapitalGain: number;
  edges: { zeroUpTo: number; fifteenUpTo: number };
  taxOn: (taxable: number) => number;
}): QdcgWorksheet {
  const { taxableIncome: l1, qualifiedDividends: l2, netCapitalGain: l3, edges, taxOn } = input;
  if (l2 < 0 || l3 < 0) throw new Error(`QDCG worksheet: line 2 (${l2}) and line 3 (${l3}) cannot be negative`);
  const l4 = l2 + l3;
  const l5 = Math.max(0, l1 - l4);
  const l6 = edges.zeroUpTo;
  const l7 = Math.min(l1, l6);
  const l8 = Math.min(l5, l7);
  const l9 = l7 - l8;
  const l10 = Math.min(l1, l4);
  const l11 = l9;
  const l12 = l10 - l11;
  const l13 = edges.fifteenUpTo;
  const l14 = Math.min(l1, l13);
  const l15 = l5 + l9;
  const l16 = Math.max(0, l14 - l15);
  const l17 = Math.min(l12, l16);
  const l18 = Math.round(l17 * 0.15 * 100) / 100;
  const l19 = l9 + l17;
  const l20 = l10 - l19;
  const l21 = Math.round(l20 * 0.2 * 100) / 100;
  const l22 = taxOn(l5);
  const l23 = Math.round(l18 + l21 + l22);
  const l24 = taxOn(l1);
  const l25 = Math.min(l23, l24);
  return {
    "1": l1, "2": l2, "3": l3, "4": l4, "5": l5, "6": l6, "7": l7, "8": l8, "9": l9, "10": l10, "11": l11, "12": l12,
    "13": l13, "14": l14, "15": l15, "16": l16, "17": l17, "18": l18, "19": l19, "20": l20, "21": l21, "22": l22,
    "23": l23, "24": l24, "25": l25,
  };
}
