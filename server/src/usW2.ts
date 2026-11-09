/**
 * A year's Form W-2 per employer, from the pay stubs' lines: the boxes the 1040 reads. One rule for
 * the app (the 1040 draft, `f1040Draft.ts`) and the demo generator, which builds the same boxes from
 * the stubs it writes (`demoData/usPayroll.ts` `usW2sFromStubs`, to be switched onto this module).
 * Pure: stubs in, W-2s out; only the year's law (`usLegalParameters.ts`) is read.
 *
 *   gross       = Σ earnings (wages, supplemental bonus, RSU vests)
 *   cafeteria   = medical + dental/vision + HSA (section 125: out of every wage box)
 *   box 1       = gross − pre-tax 401(k) − cafeteria   (a Roth 401(k) deferral and the RSU offset stay in)
 *   box 2       = Σ federal income tax withheld
 *   box 3       = gross − cafeteria, capped at the year's Social Security wage base
 *   box 4       = Σ Social Security withheld
 *   box 5       = gross − cafeteria
 *   box 6       = Σ Medicare withheld (the additional 0,9 % included)
 *   box 12 D    = Σ pre-tax 401(k); AA = Σ Roth 401(k); W = Σ HSA through the cafeteria plan
 *
 * The employer's 401(k) match is a memo line and enters no box. A stub's year is its pay date's.
 * Amounts are dollars to the cent (the W-2 prints cents; the 1040 rounds its lines).
 */
import type { PayslipLineKind, PayslipLineSide } from "./payslipLineKinds.js";
import { usTaxYear } from "./usLegalParameters.js";

export type UsW2StubLine = { side: PayslipLineSide; kind: PayslipLineKind; amount: number };

export type UsW2Stub = {
  /** Where the stub came from, for errors (the document). */
  ref: string;
  payDate: string;
  employer: string;
  ein: string;
  lines: readonly UsW2StubLine[];
};

export type UsW2 = {
  year: number;
  employer: string;
  ein: string;
  stubs: number;
  /** Box 1. */
  wages: number;
  /** Box 2. */
  federalWithheld: number;
  /** Box 3. */
  socialSecurityWages: number;
  /** Box 4. */
  socialSecurityTax: number;
  /** Box 5. */
  medicareWages: number;
  /** Box 6. */
  medicareTax: number;
  /** Box 12, code D: pre-tax 401(k) deferrals. */
  box12D: number;
  /** Box 12, code AA: Roth 401(k) deferrals. */
  box12AA: number;
  /** Box 12, code W: HSA contributions through the cafeteria plan. */
  box12W: number;
};

function cents(x: number): number {
  return Math.round(x * 100) / 100;
}

const EARNINGS = new Set<PayslipLineKind>(["wages", "supplemental_bonus", "rsu"]);
const CAFETERIA = new Set<PayslipLineKind>(["health_premium", "dental_vision", "hsa"]);
/** A deduction that enters no box (the RSU offset: the vested shares delivered, not a pre-tax deduction). */
const NO_BOX_DEDUCTIONS = new Set<PayslipLineKind>(["rsu_offset"]);

/** One stub's contribution to the boxes; throws on a line that is not a US W-2 kind. */
function stubBoxes(s: UsW2Stub) {
  const b = { gross: 0, cafeteria: 0, pretax401k: 0, roth401k: 0, hsa: 0, federal: 0, socialSecurity: 0, medicare: 0 };
  for (const l of s.lines) {
    if (l.side === "memo") {
      if (l.kind !== "employer_401k_match") throw new Error(`W-2: ${s.ref}: memo line of kind ${l.kind}`);
      continue;
    }
    if (l.side === "haber") {
      if (!EARNINGS.has(l.kind)) throw new Error(`W-2: ${s.ref}: earning of kind ${l.kind} is not a US W-2 earning`);
      b.gross += l.amount;
      continue;
    }
    if (CAFETERIA.has(l.kind)) {
      b.cafeteria += l.amount;
      if (l.kind === "hsa") b.hsa += l.amount;
    } else if (l.kind === "retirement_401k_pretax") b.pretax401k += l.amount;
    else if (l.kind === "retirement_401k_roth") b.roth401k += l.amount;
    else if (l.kind === "federal_income_tax") b.federal += l.amount;
    else if (l.kind === "social_security_tax") b.socialSecurity += l.amount;
    else if (l.kind === "medicare_tax") b.medicare += l.amount;
    else if (!NO_BOX_DEDUCTIONS.has(l.kind)) throw new Error(`W-2: ${s.ref}: deduction of kind ${l.kind} is not a US W-2 deduction`);
  }
  return b;
}

/**
 * The W-2s of the stubs, one per (employer EIN, pay-date year), oldest year first, then by EIN.
 * `lawYearFor`: whose wage base caps box 3 (the year itself; the 1040 draft passes the latest listed
 * year for an open year the law table does not list yet).
 */
export function usW2sFromStubLines(stubs: readonly UsW2Stub[], lawYearFor: (year: number) => number = (y) => y): UsW2[] {
  const byKey = new Map<string, UsW2>();
  // Pay-date order: box 3's cap applies to the year's running wages.
  const ordered = [...stubs].sort((a, b) => a.payDate.localeCompare(b.payDate) || a.ref.localeCompare(b.ref));
  for (const s of ordered) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s.payDate)) throw new Error(`W-2: ${s.ref}: pay date «${s.payDate}» is not YYYY-MM-DD`);
    const year = Number(s.payDate.slice(0, 4));
    const key = `${s.ein}|${year}`;
    let w = byKey.get(key);
    if (!w) {
      w = {
        year,
        employer: s.employer,
        ein: s.ein,
        stubs: 0,
        wages: 0,
        federalWithheld: 0,
        socialSecurityWages: 0,
        socialSecurityTax: 0,
        medicareWages: 0,
        medicareTax: 0,
        box12D: 0,
        box12AA: 0,
        box12W: 0,
      };
      byKey.set(key, w);
    } else if (w.employer !== s.employer) {
      throw new Error(`W-2: EIN ${s.ein} names two employers in ${year} («${w.employer}», «${s.employer}»)`);
    }
    const b = stubBoxes(s);
    const ficaWages = b.gross - b.cafeteria;
    w.stubs += 1;
    w.wages = cents(w.wages + b.gross - b.pretax401k - b.cafeteria);
    w.federalWithheld = cents(w.federalWithheld + b.federal);
    w.socialSecurityWages = cents(Math.min(usTaxYear(lawYearFor(year)).socialSecurityWageBase, w.socialSecurityWages + ficaWages));
    w.socialSecurityTax = cents(w.socialSecurityTax + b.socialSecurity);
    w.medicareWages = cents(w.medicareWages + ficaWages);
    w.medicareTax = cents(w.medicareTax + b.medicare);
    w.box12D = cents(w.box12D + b.pretax401k);
    w.box12AA = cents(w.box12AA + b.roth401k);
    w.box12W = cents(w.box12W + b.hsa);
  }
  return [...byKey.values()].sort((a, b) => a.year - b.year || a.ein.localeCompare(b.ein));
}
