/**
 * US federal law the app computes payroll and the 1040 with, by tax year: the income-tax brackets
 * and standard deduction per filing status, FICA (the Social Security wage base and rate, Medicare
 * and its additional 0,9 %), the 401(k), HSA and IRA limits with the Roth IRA phase-out, the
 * supplemental-wage flat rates, and Pub. 15-T's percentage method for a 2020-or-later Form W-4.
 * A leaf module (no imports), the sibling of `legalParameters.ts`: a year it does not list throws
 * (refresh it each January, when the IRS and the SSA have published the new year). No document
 * imports these figures, so there is no table for them.
 *
 * Sources: the IRS revenue procedures with the inflation adjustments (Rev. Proc. 2023-34 for 2024,
 * 2024-40 for 2025, 2025-32 for 2026), the One Big Beautiful Bill Act (P.L. 119-21; the 2025
 * standard deduction), the SSA's yearly wage-base notices, IRS notices for the retirement limits
 * (2023-75, 2024-80, 2025-67) and the HSA revenue procedures (2023-23, 2024-25, 2025-19), and
 * Pub. 15-T of each year for the withholding tables.
 *
 * Amounts are dollars; rates are fractions (0.062 = 6,2 %).
 */

export type UsFilingStatus = "single" | "married_jointly";
export const US_FILING_STATUSES: readonly UsFilingStatus[] = ["single", "married_jointly"];

/** A tax bracket: income above the previous bracket's `upTo` and up to this one is taxed at `rate`. */
export type UsBracket = { upTo: number; rate: number };

export type UsTaxYearParameters = {
  /** The 1040's brackets on taxable income. */
  brackets: Record<UsFilingStatus, readonly UsBracket[]>;
  /** The 1040's standard deduction. */
  standardDeduction: Record<UsFilingStatus, number>;
  /**
   * The standard deduction Pub. 15-T's percentage-method tables were built with. It differs from
   * the 1040's in 2025: the One Big Beautiful Bill Act raised the 2025 standard deduction in July
   * 2025, and the IRS left that year's withholding tables as published.
   */
  withholdingStandardDeduction: Record<UsFilingStatus, number>;
  socialSecurityWageBase: number;
  /** Social Security, the employee's share (the employer pays the same). */
  socialSecurityRate: number;
  /** Medicare, the employee's share (the employer pays the same). */
  medicareRate: number;
  /** Additional Medicare tax, employee only, withheld on an employer's wages above the threshold. */
  additionalMedicareRate: number;
  /** The employer withholds the additional Medicare tax on wages it pays above this in the year, whatever the filing status. */
  additionalMedicareWithholdingThreshold: number;
  /** Form 8959: the additional Medicare tax is owed on the year's Medicare wages above this, by filing status (not indexed). */
  additionalMedicareThreshold: Record<UsFilingStatus, number>;
  /** 401(k) elective deferrals (pre-tax + Roth) a person may make in the year. */
  elective401kLimit: number;
  /** The catch-up deferral allowed from age 50. */
  elective401kCatchUp: number;
  hsaLimit: { self: number; family: number };
  /** The HSA catch-up from age 55. */
  hsaCatchUp: number;
  iraLimit: number;
  iraCatchUp: number;
  /** Roth IRA contributions phase out over this modified-AGI range. */
  rothIraPhaseOut: Record<UsFilingStatus, { from: number; to: number }>;
  /** The optional flat rate on supplemental wages (bonus, RSU vest) up to $1M in the year … */
  supplementalRate: number;
  /** … and the mandatory one on what exceeds it. */
  supplementalRateAboveMillion: number;
};

const TCJA_RATES = [0.1, 0.12, 0.22, 0.24, 0.32, 0.35, 0.37] as const;

function brackets(thresholds: readonly number[]): readonly UsBracket[] {
  if (thresholds.length !== TCJA_RATES.length - 1) throw new Error("US brackets: six thresholds expected");
  return TCJA_RATES.map((rate, i) => ({ upTo: thresholds[i] ?? Infinity, rate }));
}

/** Form W-4 (2020 or later), Step 2 unchecked: Worksheet 1A line 1g, subtracted before the annual table. */
export const W4_LINE_1G: Record<UsFilingStatus, number> = { single: 8_600, married_jointly: 12_900 };

const SHARED_FICA = {
  socialSecurityRate: 0.062,
  medicareRate: 0.0145,
  additionalMedicareRate: 0.009,
  additionalMedicareWithholdingThreshold: 200_000,
  additionalMedicareThreshold: { single: 200_000, married_jointly: 250_000 },
  supplementalRate: 0.22,
  supplementalRateAboveMillion: 0.37,
} as const;

export const US_TAX_YEARS: Readonly<Record<number, UsTaxYearParameters>> = {
  2024: {
    brackets: {
      single: brackets([11_600, 47_150, 100_525, 191_950, 243_725, 609_350]),
      married_jointly: brackets([23_200, 94_300, 201_050, 383_900, 487_450, 731_200]),
    },
    standardDeduction: { single: 14_600, married_jointly: 29_200 },
    withholdingStandardDeduction: { single: 14_600, married_jointly: 29_200 },
    socialSecurityWageBase: 168_600,
    ...SHARED_FICA,
    elective401kLimit: 23_000,
    elective401kCatchUp: 7_500,
    hsaLimit: { self: 4_150, family: 8_300 },
    hsaCatchUp: 1_000,
    iraLimit: 7_000,
    iraCatchUp: 1_000,
    rothIraPhaseOut: { single: { from: 146_000, to: 161_000 }, married_jointly: { from: 230_000, to: 240_000 } },
  },
  2025: {
    brackets: {
      single: brackets([11_925, 48_475, 103_350, 197_300, 250_525, 626_350]),
      married_jointly: brackets([23_850, 96_950, 206_700, 394_600, 501_050, 751_600]),
    },
    standardDeduction: { single: 15_750, married_jointly: 31_500 },
    withholdingStandardDeduction: { single: 15_000, married_jointly: 30_000 },
    socialSecurityWageBase: 176_100,
    ...SHARED_FICA,
    elective401kLimit: 23_500,
    elective401kCatchUp: 7_500,
    hsaLimit: { self: 4_300, family: 8_550 },
    hsaCatchUp: 1_000,
    iraLimit: 7_000,
    iraCatchUp: 1_000,
    rothIraPhaseOut: { single: { from: 150_000, to: 165_000 }, married_jointly: { from: 236_000, to: 246_000 } },
  },
  2026: {
    brackets: {
      single: brackets([12_400, 50_400, 105_700, 201_775, 256_225, 640_600]),
      married_jointly: brackets([24_800, 100_800, 211_400, 403_550, 512_450, 768_700]),
    },
    standardDeduction: { single: 16_100, married_jointly: 32_200 },
    // provisional: Pub. 15-T (2026) assumed built on the 1040's 2026 standard deduction, as every year but 2025.
    withholdingStandardDeduction: { single: 16_100, married_jointly: 32_200 },
    socialSecurityWageBase: 184_500,
    ...SHARED_FICA,
    elective401kLimit: 24_500,
    elective401kCatchUp: 8_000,
    hsaLimit: { self: 4_400, family: 8_750 },
    hsaCatchUp: 1_000,
    iraLimit: 7_500,
    iraCatchUp: 1_100,
    rothIraPhaseOut: { single: { from: 153_000, to: 168_000 }, married_jointly: { from: 242_000, to: 252_000 } },
  },
};

/** The year's parameters; throws for a year the table does not list. */
export function usTaxYear(year: number): UsTaxYearParameters {
  const p = US_TAX_YEARS[year];
  if (!p) throw new Error(`US legal parameters: no figures for ${year} — add the year to usLegalParameters.ts`);
  return p;
}

/** Tax by the brackets on a taxable amount, unrounded (0 for 0 or less). */
export function usBracketTax(taxable: number, table: readonly UsBracket[]): number {
  if (taxable <= 0) return 0;
  let tax = 0;
  let floor = 0;
  for (const b of table) {
    if (taxable <= floor) break;
    tax += (Math.min(taxable, b.upTo) - floor) * b.rate;
    floor = b.upTo;
  }
  return tax;
}

/** The 1040's regular income tax on taxable income (after the deduction), unrounded. */
export function usIncomeTax(taxableIncome: number, status: UsFilingStatus, year: number): number {
  return usBracketTax(taxableIncome, usTaxYear(year).brackets[status]);
}

/** The 1040 instructions' Tax Table covers taxable income below this; above it, the Tax Computation Worksheet. */
export const US_TAX_TABLE_CEILING = 100_000;
/** The Tax Table's rows are $25 wide below this and $50 wide from it (the first rows: 0–5, 5–15, 15–25). */
const US_TAX_TABLE_NARROW_ROWS_BELOW = 3_000;

/**
 * Line 16 of the 1040 on taxable income (line 15, whole dollars), as the instructions compute it:
 * below {@link US_TAX_TABLE_CEILING} the Tax Table — the brackets' tax on the midpoint of the
 * income's row, rounded to the dollar — and from it the Tax Computation Worksheet (the brackets
 * on the exact amount), rounded to the dollar. 0 for 0 or less.
 */
export function usForm1040Tax(taxableIncome: number, status: UsFilingStatus, year: number): number {
  const table = usTaxYear(year).brackets[status];
  if (taxableIncome <= 0) return 0;
  if (taxableIncome >= US_TAX_TABLE_CEILING) return Math.round(usBracketTax(taxableIncome, table));
  let midpoint: number;
  if (taxableIncome < 5) return 0;
  else if (taxableIncome < 15) midpoint = 10;
  else if (taxableIncome < 25) midpoint = 20;
  else {
    const width = taxableIncome < US_TAX_TABLE_NARROW_ROWS_BELOW ? 25 : 50;
    midpoint = Math.floor(taxableIncome / width) * width + width / 2;
  }
  return Math.round(usBracketTax(midpoint, table));
}

/** Pay periods a year. */
export const US_PAY_PERIODS_PER_YEAR = { biweekly: 26, semi_monthly: 24 } as const;
export type UsPayFrequency = keyof typeof US_PAY_PERIODS_PER_YEAR;

function cents(x: number): number {
  return Math.round(x * 100) / 100;
}

/**
 * Pub. 15-T's percentage method for automated payroll (Worksheet 1A) on one period's wages subject
 * to federal withholding, for a 2020-or-later Form W-4 with only Step 1(c) filled (Step 2
 * unchecked, no Step 3 credits, no Step 4 adjustments): wages × periods, less the line-1g amount,
 * through the annual table (the brackets shifted by the withholding standard deduction less line
 * 1g), divided back by the periods. Rounded to the cent (Pub. 15-T lets the employer round to the
 * dollar). Unknown years throw.
 */
export function usPercentageMethodWithholding(periodWages: number, frequency: UsPayFrequency, status: UsFilingStatus, year: number): number {
  const p = usTaxYear(year);
  const periods = US_PAY_PERIODS_PER_YEAR[frequency];
  const adjustedAnnual = periodWages * periods - W4_LINE_1G[status];
  const tableStart = p.withholdingStandardDeduction[status] - W4_LINE_1G[status];
  const annual = usBracketTax(adjustedAnnual - tableStart, p.brackets[status]);
  return cents(annual / periods);
}

/** Flat withholding on supplemental wages (bonus, RSU vest), given the year's supplemental wages before them. */
export function usSupplementalWithholding(supplemental: number, priorSupplementalInYear: number, year: number): number {
  const p = usTaxYear(year);
  const room = Math.max(0, 1_000_000 - priorSupplementalInYear);
  const atFlat = Math.min(supplemental, room);
  return cents(atFlat * p.supplementalRate + (supplemental - atFlat) * p.supplementalRateAboveMillion);
}

/** Social Security withheld on a payment, given the employer's year-to-date FICA wages before it (to the cent). */
export function usSocialSecurityTax(wages: number, priorWagesInYear: number, year: number): number {
  const p = usTaxYear(year);
  const room = Math.max(0, p.socialSecurityWageBase - priorWagesInYear);
  return cents(Math.min(wages, room) * p.socialSecurityRate);
}

/** Medicare withheld on a payment (1,45 %, plus 0,9 % on the employer's wages above the threshold), to the cent. */
export function usMedicareTax(wages: number, priorWagesInYear: number, year: number): number {
  const p = usTaxYear(year);
  const above = Math.max(0, priorWagesInYear + wages - Math.max(p.additionalMedicareWithholdingThreshold, priorWagesInYear));
  return cents(wages * p.medicareRate + above * p.additionalMedicareRate);
}
