/**
 * The local Form 1040 (US federal individual return), v1, for one calendar tax year, from the US
 * W-2 pay stubs (`payroll_work_earnings.jurisdiction = 'us'` and their `payslip_lines`): the W-2s
 * (`usW2.ts`), then
 *
 *   1a   wages: Σ W-2 box 1                     12   the standard deduction for the filing status
 *   15   taxable income                          16   the tax on it (Tax Table / worksheet)
 *   23   Form 8959's additional Medicare tax (Medicare wages above the status threshold)
 *   25a  Σ W-2 box 2                             25c  the additional Medicare tax withheld
 *   31   Schedule 3: Social Security withheld above the year's maximum by two or more employers
 *   34 / 35a refund, or 37 amount owed
 *
 * and the rest by the form's arithmetic (`f1040Identities.ts`). Social Security and Medicare (boxes
 * 4 and 6) are reported beside the return, not part of its tax. No itemized deductions, no other
 * income (1099s, Schedule E: v2), no credits. The filing status is the W-4's on the year's stubs
 * (one, or the draft throws). No state return: the stubs carry no state withholding (a job in a
 * state without income tax). The year's law comes from `usLegalParameters.ts`: a closed year it does
 * not list throws; the open year (provisional: the stubs to date) uses its own figures when listed,
 * else the latest year's (`lawYear`).
 */
import { chileWallClockNow } from "./chileDate.js";
import { db } from "./db.js";
import { computeF1040Lines, type F1040Lines } from "./f1040Identities.js";
import { filedF1040, filedF1040TaxYears, type FiledF1040 } from "./f1040Filed.js";
import type { PayslipLineKind, PayslipLineSide } from "./payslipLineKinds.js";
import { US_TAX_YEARS, usForm1040Tax, usTaxYear, type UsFilingStatus } from "./usLegalParameters.js";
import { usW2sFromStubLines, type UsW2, type UsW2Stub } from "./usW2.js";

export type F1040Note =
  /** The stubs carry no state withholding: no state return is drafted. */
  | "no_state_return"
  /** The first US year began after January: a dual-status year, drafted as a full resident year. */
  | "first_year_full_resident"
  /** The open year: the stubs to date, not the year's total. */
  | "open_year"
  /** The open year's law is not in the table yet: the latest listed year's figures stand in. */
  | "law_provisional";

export type F1040Draft = {
  taxYear: number;
  provisional: boolean;
  /** Whose law the draft applied (the tax year itself, or the latest listed one for an open year). */
  lawYear: number;
  filingStatus: UsFilingStatus;
  stubs: number;
  w2s: UsW2[];
  lines: F1040Lines;
  /** Boxes 4 and 6: withheld and reported, not part of the 1040's tax. */
  fica: { socialSecurity: number; medicare: number };
  /** Form 8959's tax on the year's Medicare wages above the threshold (dollars to the cent). */
  additionalMedicareTax: number;
  filed: FiledF1040 | null;
  notes: F1040Note[];
};

type StubRow = {
  id: number;
  source_pdf: string;
  pay_date: string | null;
  employer_name: string;
  employer_rut: string | null;
  w4_filing_status: UsFilingStatus | null;
};

function currentYear(todayYmd: string): number {
  return Number(todayYmd.slice(0, 4));
}

/** The first year with a US pay stub, or null without any. */
function firstUsPayYear(): number | null {
  const unpaid = db.prepare(`SELECT source_pdf FROM payroll_work_earnings WHERE jurisdiction = 'us' AND pay_date IS NULL LIMIT 1`).get() as
    | { source_pdf: string }
    | undefined;
  if (unpaid) throw new Error(`1040: US payslip ${unpaid.source_pdf} has no pay date`);
  const r = db.prepare(`SELECT MIN(pay_date) AS d FROM payroll_work_earnings WHERE jurisdiction = 'us'`).get() as { d: string | null };
  return r.d == null ? null : Number(r.d.slice(0, 4));
}

/**
 * Every tax year from the first one with a US pay stub through the current one, plus any year with
 * a filed return — newest first. Empty without US pay stubs or filed returns.
 */
export function availableUsTaxYears(todayYmd: string = chileWallClockNow().ymd): number[] {
  const years = new Set(filedF1040TaxYears());
  const first = firstUsPayYear();
  if (first != null) for (let y = first; y <= currentYear(todayYmd); y++) years.add(y);
  return [...years].sort((a, b) => b - a);
}

function loadStubs(taxYear: number): { stubs: UsW2Stub[]; statuses: Set<UsFilingStatus>; firstPayDate: string | null } {
  const heads = db
    .prepare(
      `SELECT id, source_pdf, pay_date, employer_name, employer_rut, w4_filing_status FROM payroll_work_earnings
        WHERE jurisdiction = 'us' AND pay_date LIKE ? ORDER BY pay_date, id`
    )
    .all(`${taxYear}-%`) as StubRow[];
  const lineRows = db
    .prepare(
      `SELECT l.payslip_id, l.side, l.kind, l.amount FROM payslip_lines l
         JOIN payroll_work_earnings p ON p.id = l.payslip_id
        WHERE p.jurisdiction = 'us' AND p.pay_date LIKE ? ORDER BY l.payslip_id, l.position`
    )
    .all(`${taxYear}-%`) as { payslip_id: number; side: PayslipLineSide; kind: PayslipLineKind | null; amount: number }[];
  const linesById = new Map<number, UsW2Stub["lines"][number][]>();
  for (const l of lineRows) {
    if (l.kind == null) throw new Error(`1040: payslip ${l.payslip_id} has a line without a kind`);
    const list = linesById.get(l.payslip_id) ?? [];
    list.push({ side: l.side, kind: l.kind, amount: l.amount });
    linesById.set(l.payslip_id, list);
  }
  const statuses = new Set<UsFilingStatus>();
  const stubs = heads.map((h): UsW2Stub => {
    if (h.employer_rut == null) throw new Error(`1040: US payslip ${h.source_pdf} has no employer EIN`);
    if (h.w4_filing_status == null) throw new Error(`1040: US payslip ${h.source_pdf} has no W-4 filing status`);
    statuses.add(h.w4_filing_status);
    const lines = linesById.get(h.id);
    if (!lines) throw new Error(`1040: US payslip ${h.source_pdf} has no lines`);
    return { ref: h.source_pdf, payDate: h.pay_date!, employer: h.employer_name, ein: h.employer_rut, lines };
  });
  return { stubs, statuses, firstPayDate: heads[0]?.pay_date ?? null };
}

/** The W-4 filing status of the latest stub before the year (an open year with no stub yet). */
function latestFilingStatusBefore(taxYear: number): UsFilingStatus {
  const r = db
    .prepare(
      `SELECT w4_filing_status AS s FROM payroll_work_earnings
        WHERE jurisdiction = 'us' AND pay_date < ? ORDER BY pay_date DESC, id DESC LIMIT 1`
    )
    .get(`${taxYear}-01-01`) as { s: UsFilingStatus | null } | undefined;
  if (!r || r.s == null) throw new Error(`1040 ${taxYear}: no US pay stub to take a filing status from`);
  return r.s;
}

function lawYearFor(taxYear: number, provisional: boolean): number {
  if (US_TAX_YEARS[taxYear] || !provisional) {
    usTaxYear(taxYear); // a closed year needs its own law: throws when the table does not list it
    return taxYear;
  }
  const listed = Object.keys(US_TAX_YEARS).map(Number).filter((y) => y < taxYear);
  if (listed.length === 0) throw new Error(`1040 ${taxYear}: no US law listed before ${taxYear}`);
  return Math.max(...listed);
}

const cents = (x: number) => Math.round(x * 100) / 100;

export function buildF1040Draft(taxYear: number, todayYmd: string = chileWallClockNow().ymd): F1040Draft {
  if (!Number.isInteger(taxYear)) throw new Error(`1040: tax year ${taxYear}`);
  const provisional = taxYear >= currentYear(todayYmd);
  if (taxYear > currentYear(todayYmd)) throw new Error(`1040 ${taxYear}: a year that has not started`);
  const lawYear = lawYearFor(taxYear, provisional);
  const { stubs, statuses, firstPayDate } = loadStubs(taxYear);
  if (statuses.size > 1) throw new Error(`1040 ${taxYear}: the stubs carry several W-4 filing statuses (${[...statuses].join(", ")})`);
  const filingStatus = statuses.size === 1 ? [...statuses][0]! : latestFilingStatusBefore(taxYear);
  const w2s = usW2sFromStubLines(stubs, (y) => (y === taxYear ? lawYear : y));

  const { lines, additionalMedicareTax, fica } = f1040LinesFromW2s(w2s, filingStatus, lawYear, `${taxYear}`);

  const notes: F1040Note[] = ["no_state_return"];
  const first = firstUsPayYear();
  if (first === taxYear && firstPayDate != null && firstPayDate > `${taxYear}-01-31`) notes.push("first_year_full_resident");
  if (provisional) notes.push("open_year");
  if (lawYear !== taxYear) notes.push("law_provisional");

  return {
    taxYear,
    provisional,
    lawYear,
    filingStatus,
    stubs: stubs.length,
    w2s,
    lines,
    fica,
    additionalMedicareTax,
    filed: filedF1040(taxYear),
    notes,
  };
}

/**
 * The 1040's lines from a year's W-2s, for a filing status under `lawYear`'s law (pure: the draft
 * above and the demo generator's April, which drafts the return from the stubs it wrote, share it).
 */
export function f1040LinesFromW2s(
  w2s: readonly UsW2[],
  filingStatus: UsFilingStatus,
  lawYear: number,
  label: string
): { lines: ReturnType<typeof computeF1040Lines>; additionalMedicareTax: number; fica: { socialSecurity: number; medicare: number } } {
  const law = usTaxYear(lawYear);
  const sum = (f: (w: UsW2) => number) => cents(w2s.reduce((s, w) => s + f(w), 0));
  const medicareWages = sum((w) => w.medicareWages);
  const medicareWithheld = sum((w) => w.medicareTax);
  const additionalMedicareTax = cents(Math.max(0, medicareWages - law.additionalMedicareThreshold[filingStatus]) * law.additionalMedicareRate);
  // Form 8959 part V: Medicare withheld beyond the regular 1,45 % is the additional tax withheld.
  const additionalWithheldRaw = Math.round(medicareWithheld - medicareWages * law.medicareRate);
  const additionalWithheld = additionalWithheldRaw === 0 ? 0 : additionalWithheldRaw; // never −0
  if (additionalWithheld < 0) {
    throw new Error(`1040 ${label}: Medicare withheld (${medicareWithheld}) is below 1,45 % of the Medicare wages (${medicareWages})`);
  }
  // Schedule 3 line 11: with two or more employers, Social Security withheld above the maximum.
  const maxSocialSecurity = cents(law.socialSecurityWageBase * law.socialSecurityRate);
  for (const w of w2s) {
    if (w.socialSecurityTax > maxSocialSecurity + 0.005) {
      throw new Error(`1040 ${label}: ${w.employer} withheld ${w.socialSecurityTax} of Social Security, above the year's maximum ${maxSocialSecurity}`);
    }
  }
  const excessSocialSecurity = w2s.length > 1 ? Math.round(Math.max(0, sum((w) => w.socialSecurityTax) - maxSocialSecurity)) : 0;

  const lines = computeF1040Lines({
    wages1a: Math.round(sum((w) => w.wages)),
    standardDeduction12: law.standardDeduction[filingStatus],
    taxOn: (taxable) => usForm1040Tax(taxable, filingStatus, lawYear),
    otherTaxes23: Math.round(additionalMedicareTax),
    withholdingW2_25a: Math.round(sum((w) => w.federalWithheld)),
    withholdingOther25c: additionalWithheld,
    schedule3Credits31: excessSocialSecurity,
  });

  return { lines, additionalMedicareTax, fica: { socialSecurity: sum((w) => w.socialSecurityTax), medicare: medicareWithheld } };
}
