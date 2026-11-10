/**
 * The arithmetic Form 1040 prints between its lines, in one place: the draft (`us1040/draft.ts`)
 * computes its lines with it and a filed return (`us1040/filed.ts`) is checked against it, so the two
 * cannot disagree. A leaf: no imports. Whole dollars throughout (the form's rounding: each amount to
 * the dollar, a sum of several rounded only at the total). The schedules feeding the lines are their
 * own modules (`scheduleB.ts`, `scheduleD.ts`, `qualifiedDividendsWorksheet.ts`, `form8960.ts`,
 * `schedule2.ts`, `dualStatus.ts`); this module only states how the lines add up.
 *
 * **Lines are roles named by the 2024 form's numbers; the year's form prints them under its own.**
 * The 2025 Form 1040 (irs.gov `f1040.pdf`, «Form 1040 (2025)», and its instructions `i1040gi`,
 * read 2026-11-10; docs/us-1040-readings.md §13) renumbered: «7a Capital gain or (loss)» (7b the
 * «Schedule D not required» box), «11a … adjusted gross income» (page 1) and «11b Amount from line
 * 11a» (page 2), «12e Standard deduction or itemized deductions» after the 12a–12d check boxes
 * (12c: dual-status alien), «13a Qualified business income deduction», «13b Additional deductions
 * from Schedule 1-A, line 38» (new in 2025), «14 Add lines 12e, 13a, and 13b», «15 Subtract line 14
 * from line 11b». Lines 1a–1z, 2a–3b, 8–10 and 16–38 kept their numbers. So role «7» prints as 7a,
 * «11» as 11a (11b repeats it), «12» as 12e, «13» as 13a, and «13b» exists from 2025
 * ({@link f1040PrintedLine}, {@link f1040RoleOfPrintedLine}; a 2024 return carrying 13b throws).
 *
 *    1z = 1a                                   (wages; the W-2s' box 1 — 1b–1h are not drafted)
 *     9 = 1z + 2b + 3b + 7 + 8                 (total income: taxable interest, ordinary dividends,
 *                                               capital gain or loss, Schedule 1 line 10; 2a and
 *                                               3a are information lines; 4b–6b are not modelled)
 *    11 = 9 − 10                               (AGI; 10 = Schedule 1 adjustments)
 *    14 = 12 + 13 + 13b                        (12 the standard or itemized deduction — 0 on a
 *                                               dual-status return —, 13 the QBI deduction, 13b
 *                                               Schedule 1-A's additional deductions, 2025 on)
 *    15 = max(0, 11 − 14)                      (taxable income)
 *    18 = 16 + 17                              (16 the tax on 15; 17 Schedule 2 part I)
 *    21 = 19 + 20                              (19 child tax credit; 20 Schedule 3 line 8, the
 *                                               foreign tax credit among them)
 *    22 = max(0, 18 − 21)
 *    24 = 22 + 23                              (23 Schedule 2 line 21: Form 8959, Form 8960)
 *   25d = 25a + 25b + 25c                      (25a W-2s, 25b 1099s, 25c other: Form 8959's, 1042-S)
 *    32 = 27 + 28 + 29 + 31                    (31: Schedule 3, e.g. excess Social Security)
 *    33 = 25d + 26 + 32                        (total payments)
 *    34 = max(0, 33 − 24)                      (overpaid)
 *   35a = 34 − 36                              (refunded; 36 applied to next year's estimate)
 *    37 = max(0, 24 − 33)                      (amount owed)
 *
 * and 3a ≤ 3b (qualified dividends are part of the ordinary ones).
 */

/** The 1040 lines the app drafts or reads from a filed return — roles, in the 2024 form's numbering (see the header). */
export const F1040_LINES = [
  "1a", "1z", "2a", "2b", "3a", "3b", "7", "8", "9", "10", "11", "12", "13", "13b", "14", "15", "16", "17", "18",
  "19", "20", "21", "22", "23", "24", "25a", "25b", "25c", "25d", "26", "27", "28", "29", "31", "32", "33", "34",
  "35a", "36", "37",
] as const;
export type F1040Line = (typeof F1040_LINES)[number];
export type F1040Lines = Partial<Record<F1040Line, number>>;

export function isF1040Line(line: string): line is F1040Line {
  return (F1040_LINES as readonly string[]).includes(line);
}

/** The first tax year whose form renumbered the deduction lines (the 2025 Form 1040). */
export const F1040_RENUMBERED_FROM_YEAR = 2025;

/** Role → the number the 2025 form prints, where it differs from the role's name. */
const PRINTED_FROM_2025: Partial<Record<F1040Line, string>> = { "7": "7a", "11": "11a", "12": "12e", "13": "13a" };

/** Printed number → role on the 2025 form, where it differs (11b repeats 11a and reads as the same role). */
const ROLE_FROM_2025: Record<string, F1040Line> = { "7a": "7", "11a": "11", "11b": "11", "12e": "12", "13a": "13" };

/** Roles the form before 2025 had no line for. */
const ONLY_FROM_2025 = new Set<F1040Line>(["13b"]);

/** Whether `taxYear`'s form prints a line for the role (13b only from 2025). */
export function f1040YearHasLine(role: F1040Line, taxYear: number): boolean {
  return taxYear >= F1040_RENUMBERED_FROM_YEAR || !ONLY_FROM_2025.has(role);
}

/** The number `taxYear`'s Form 1040 prints for a role (the payload prints it; the identities read roles). */
export function f1040PrintedLine(role: F1040Line, taxYear: number): string {
  if (taxYear >= F1040_RENUMBERED_FROM_YEAR) return PRINTED_FROM_2025[role] ?? role;
  if (ONLY_FROM_2025.has(role)) throw new Error(`1040 ${taxYear}: the form has no line ${role} (2025 on)`);
  return role;
}

/** The role of a line as `taxYear`'s form prints it; throws for a number that form does not print. */
export function f1040RoleOfPrintedLine(printed: string, taxYear: number): F1040Line {
  if (taxYear >= F1040_RENUMBERED_FROM_YEAR) {
    const mapped = ROLE_FROM_2025[printed];
    if (mapped) return mapped;
    if (printed === "7" || printed === "11" || printed === "12" || printed === "13") {
      throw new Error(`1040 ${taxYear}: the form prints no line ${printed} (7a, 11a/11b, 12e, 13a/13b)`);
    }
  } else if (printed in ROLE_FROM_2025 || ONLY_FROM_2025.has(printed as F1040Line)) {
    throw new Error(`1040 ${taxYear}: the form prints no line ${printed} (2025 on)`);
  }
  if (!isF1040Line(printed)) throw new Error(`1040 ${taxYear}: unknown line ${printed}`);
  return printed;
}

/** The inputs a draft supplies; every other line follows from them. */
export type F1040Inputs = {
  wages1a: number;
  /** Tax-exempt interest (information only). */
  taxExemptInterest2a: number;
  /** Taxable interest (Schedule B line 4). */
  interest2b: number;
  /** Qualified dividends (part of 3b). */
  qualifiedDividends3a: number;
  /** Ordinary dividends (Schedule B line 6). */
  ordinaryDividends3b: number;
  /** Capital gain or loss (Schedule D line 16, or line 21 for a loss). */
  capitalGain7: number;
  /** Schedule 1 line 10: Schedule E, other income (line 8z). */
  additionalIncome8: number;
  /** Schedule 1 line 26. */
  adjustments10: number;
  /** The standard deduction, itemized deductions, or 0 (a dual-status return takes no standard deduction). */
  deduction12: number;
  qbiDeduction13: number;
  /** Schedule 1-A (2025 on). */
  additionalDeductions13b: number;
  /** Line 16 on line 15 (the Tax Table, the worksheet, the Qualified Dividends and Capital Gain Tax Worksheet). */
  taxOn: (taxableIncome15: number) => number;
  /** Schedule 2 line 3. */
  schedule2Part1_17: number;
  childTaxCredit19: number;
  /** Schedule 3 line 8 (the foreign tax credit, Schedule 3 line 1, among them). */
  schedule3Nonrefundable20: number;
  /** Schedule 2 line 21. */
  otherTaxes23: number;
  withholdingW2_25a: number;
  withholding1099_25b: number;
  /** Form 8959's additional Medicare withheld, Form 1042-S. */
  withholdingOther25c: number;
  /** Schedule 3's refundable credits (line 31). */
  schedule3Credits31: number;
};

export type F1040ComputedLine =
  | "1a" | "1z" | "2a" | "2b" | "3a" | "3b" | "7" | "8" | "9" | "10" | "11" | "12" | "13" | "13b" | "14" | "15" | "16"
  | "17" | "18" | "19" | "20" | "21" | "22" | "23" | "24" | "25a" | "25b" | "25c" | "25d" | "31" | "32" | "33" | "34"
  | "35a" | "37";

/** Every line the draft states, from its inputs. */
export function computeF1040Lines(i: F1040Inputs): Required<Pick<F1040Lines, F1040ComputedLine>> {
  for (const [k, v] of Object.entries(i)) {
    if (typeof v === "number" && !Number.isInteger(v)) throw new Error(`1040: input ${k} = ${v} is not whole dollars`);
  }
  if (i.qualifiedDividends3a > i.ordinaryDividends3b) {
    throw new Error(`1040: qualified dividends ${i.qualifiedDividends3a} exceed the ordinary dividends ${i.ordinaryDividends3b}`);
  }
  const l1z = i.wages1a;
  const l9 = l1z + i.interest2b + i.ordinaryDividends3b + i.capitalGain7 + i.additionalIncome8;
  const l11 = l9 - i.adjustments10;
  const l14 = i.deduction12 + i.qbiDeduction13 + i.additionalDeductions13b;
  const l15 = Math.max(0, l11 - l14);
  const l16 = i.taxOn(l15);
  if (!Number.isInteger(l16)) throw new Error(`1040: line 16 = ${l16} is not whole dollars`);
  const l18 = l16 + i.schedule2Part1_17;
  const l21 = i.childTaxCredit19 + i.schedule3Nonrefundable20;
  const l22 = Math.max(0, l18 - l21);
  const l24 = l22 + i.otherTaxes23;
  const l25d = i.withholdingW2_25a + i.withholding1099_25b + i.withholdingOther25c;
  const l32 = i.schedule3Credits31;
  const l33 = l25d + l32;
  const l34 = Math.max(0, l33 - l24);
  return {
    "1a": i.wages1a,
    "1z": l1z,
    "2a": i.taxExemptInterest2a,
    "2b": i.interest2b,
    "3a": i.qualifiedDividends3a,
    "3b": i.ordinaryDividends3b,
    "7": i.capitalGain7,
    "8": i.additionalIncome8,
    "9": l9,
    "10": i.adjustments10,
    "11": l11,
    "12": i.deduction12,
    "13": i.qbiDeduction13,
    "13b": i.additionalDeductions13b,
    "14": l14,
    "15": l15,
    "16": l16,
    "17": i.schedule2Part1_17,
    "18": l18,
    "19": i.childTaxCredit19,
    "20": i.schedule3Nonrefundable20,
    "21": l21,
    "22": l22,
    "23": i.otherTaxes23,
    "24": l24,
    "25a": i.withholdingW2_25a,
    "25b": i.withholding1099_25b,
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

/**
 * Throws unless a return's lines (roles) satisfy the form's arithmetic (missing lines read 0). With
 * `taxYear`, a line the year's form does not print (13b before 2025) must be absent or 0.
 */
export function assertF1040Identities(lines: F1040Lines, label: string, taxYear?: number): void {
  const v = (l: F1040Line) => lines[l] ?? 0;
  for (const [k, x] of Object.entries(lines)) {
    if (!isF1040Line(k)) throw new Error(`1040 ${label}: unknown line ${k}`);
    if (!Number.isInteger(x)) throw new Error(`1040 ${label}: line ${k} = ${x} is not whole dollars`);
    if (taxYear != null && taxYear < F1040_RENUMBERED_FROM_YEAR && ONLY_FROM_2025.has(k) && x !== 0) {
      throw new Error(`1040 ${label}: line ${k} = ${x}, but the ${taxYear} form has no line ${k} (2025 on)`);
    }
  }
  if (v("3a") > v("3b")) throw new Error(`1040 ${label}: line 3a (${v("3a")}) exceeds line 3b (${v("3b")})`);
  const checks: [F1040Line, number][] = [
    ["1z", v("1a")],
    ["9", v("1z") + v("2b") + v("3b") + v("7") + v("8")],
    ["11", v("9") - v("10")],
    ["14", v("12") + v("13") + v("13b")],
    ["15", Math.max(0, v("11") - v("14"))],
    ["18", v("16") + v("17")],
    ["21", v("19") + v("20")],
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
