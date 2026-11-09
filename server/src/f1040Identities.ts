/**
 * The arithmetic Form 1040 prints between its lines (the 2024 form's numbering), in one place: the
 * draft (`f1040Draft.ts`) computes its lines with it and a filed return (`f1040Filed.ts`) is checked
 * against it, so the two cannot disagree. A leaf: no imports. Whole dollars throughout (the form's
 * rounding: each amount to the dollar, a sum of several rounded only at the total).
 *
 *    1z = 1a + 1b + … + 1h                    (wages; v1 drafts 1a, the W-2s' box 1)
 *     9 = 1z                                   (total income; v1 has no other income lines)
 *    11 = 9 − 10                               (AGI; 10 = Schedule 1 adjustments)
 *    14 = 12 + 13                              (12 the standard deduction, 13 the QBI deduction)
 *    15 = max(0, 11 − 14)                      (taxable income)
 *    18 = 16 + 17                              (16 the tax on 15; 17 Schedule 2 part I)
 *    22 = max(0, 18 − 21)                      (21 the nonrefundable credits)
 *    24 = 22 + 23                              (23 Schedule 2 part II: the additional Medicare tax)
 *   25d = 25a + 25b + 25c                      (25a W-2 withholding, 25c Form 8959's)
 *    32 = 27 + 28 + 29 + 31                    (31: Schedule 3, e.g. excess Social Security)
 *    33 = 25d + 26 + 32                        (total payments)
 *    34 = max(0, 33 − 24)                      (overpaid)
 *   35a = 34 − 36                              (refunded; 36 applied to next year's estimate)
 *    37 = max(0, 24 − 33)                      (amount owed)
 */

/** The 1040 lines the app drafts or reads from a filed return. */
export const F1040_LINES = [
  "1a", "1z", "9", "10", "11", "12", "13", "14", "15", "16", "17", "18", "21", "22", "23", "24",
  "25a", "25b", "25c", "25d", "26", "27", "28", "29", "31", "32", "33", "34", "35a", "36", "37",
] as const;
export type F1040Line = (typeof F1040_LINES)[number];
export type F1040Lines = Partial<Record<F1040Line, number>>;

export function isF1040Line(line: string): line is F1040Line {
  return (F1040_LINES as readonly string[]).includes(line);
}

/** The inputs a draft supplies; every other line follows from them. */
export type F1040Inputs = {
  wages1a: number;
  standardDeduction12: number;
  /** Line 16 on line 15 (the Tax Table or the worksheet). */
  taxOn: (taxableIncome15: number) => number;
  otherTaxes23: number;
  withholdingW2_25a: number;
  withholdingOther25c: number;
  /** Schedule 3's refundable credits (line 31). */
  schedule3Credits31: number;
};

/** Every line the draft states, from its inputs. */
export function computeF1040Lines(i: F1040Inputs): Required<Pick<F1040Lines, "1a" | "1z" | "9" | "11" | "12" | "14" | "15" | "16" | "18" | "22" | "23" | "24" | "25a" | "25c" | "25d" | "31" | "32" | "33" | "34" | "35a" | "37">> {
  for (const [k, v] of Object.entries(i)) {
    if (typeof v === "number" && !Number.isInteger(v)) throw new Error(`1040: input ${k} = ${v} is not whole dollars`);
  }
  const l1z = i.wages1a;
  const l9 = l1z;
  const l11 = l9;
  const l14 = i.standardDeduction12;
  const l15 = Math.max(0, l11 - l14);
  const l16 = i.taxOn(l15);
  if (!Number.isInteger(l16)) throw new Error(`1040: line 16 = ${l16} is not whole dollars`);
  const l18 = l16;
  const l22 = l18;
  const l24 = l22 + i.otherTaxes23;
  const l25d = i.withholdingW2_25a + i.withholdingOther25c;
  const l32 = i.schedule3Credits31;
  const l33 = l25d + l32;
  const l34 = Math.max(0, l33 - l24);
  return {
    "1a": i.wages1a,
    "1z": l1z,
    "9": l9,
    "11": l11,
    "12": i.standardDeduction12,
    "14": l14,
    "15": l15,
    "16": l16,
    "18": l18,
    "22": l22,
    "23": i.otherTaxes23,
    "24": l24,
    "25a": i.withholdingW2_25a,
    "25c": i.withholdingOther25c,
    "25d": l25d,
    "31": i.schedule3Credits31,
    "32": l32,
    "33": l33,
    "34": l34,
    "35a": l34,
    "37": Math.max(0, l24 - l33),
  };
}

/** Throws unless a return's lines satisfy the form's arithmetic (missing lines read 0). */
export function assertF1040Identities(lines: F1040Lines, label: string): void {
  const v = (l: F1040Line) => lines[l] ?? 0;
  for (const [k, x] of Object.entries(lines)) {
    if (!isF1040Line(k)) throw new Error(`1040 ${label}: unknown line ${k}`);
    if (!Number.isInteger(x)) throw new Error(`1040 ${label}: line ${k} = ${x} is not whole dollars`);
  }
  const checks: [F1040Line, number][] = [
    ["1z", v("1a")],
    ["9", v("1z")],
    ["11", v("9") - v("10")],
    ["14", v("12") + v("13")],
    ["15", Math.max(0, v("11") - v("14"))],
    ["18", v("16") + v("17")],
    ["22", Math.max(0, v("18") - v("21"))],
    ["24", v("22") + v("23")],
    ["25d", v("25a") + v("25b") + v("25c")],
    ["32", v("27") + v("28") + v("29") + v("31")],
    ["33", v("25d") + v("26") + v("32")],
    ["34", Math.max(0, v("33") - v("24"))],
    ["35a", v("34") - v("36")],
    ["37", Math.max(0, v("24") - v("33"))],
  ];
  for (const [line, expected] of checks) {
    if (v(line) !== expected) throw new Error(`1040 ${label}: line ${line} is ${v(line)}, the form's arithmetic gives ${expected}`);
  }
}
