/**
 * A US W-2 job's pay stubs, as the employer's payroll provider computes them: biweekly, federal
 * withholding by Pub. 15-T's percentage method for the W-4 posture plus the flat supplemental rate
 * on a bonus, Social Security and Medicare on the FICA wages with the employer's year-to-date wages,
 * a pre-tax 401(k) deferral (capped at the year's limit) with the employer's match, and the medical,
 * dental/vision and HSA deductions of a cafeteria plan. The formulas are the app's own US law
 * (`usLegalParameters.ts`) in the order the payslip checks read a stub (`payslipChecks.ts`), so
 * every generated stub checks clean. Pure: dates and dollars in, stubs out.
 */
import { isNyseTradingDay } from "../marketHolidays.js";
import {
  usMedicareTax,
  usPercentageMethodWithholding,
  usSocialSecurityTax,
  usSupplementalWithholding,
  usTaxYear,
} from "../usLegalParameters.js";
import { addDays, monthOf, monthsBetween, type UsW2Job, type Ymd } from "./person.js";

function cents(x: number): number {
  return Math.round(x * 100) / 100;
}

export type UsPayStubLine = { side: "haber" | "descuento" | "memo"; label: string; amount: number };

export type UsPayStub = {
  job: UsW2Job;
  payDate: Ymd;
  periodStart: Ymd;
  periodEnd: Ymd;
  regular: number;
  bonus: number;
  federal: number;
  socialSecurity: number;
  medicare: number;
  /** Employee pre-tax deferral. */
  k401: number;
  /** Employer match (a memo line: outside the stub's sums). */
  match: number;
  medical: number;
  dentalVision: number;
  hsa: number;
  gross: number;
  deductions: number;
  net: number;
  lines: UsPayStubLine[];
};

/** A scheduled pay date and the day it was paid (the business day before when the market is closed). */
export type UsPayDate = { nominal: Ymd; paid: Ymd };

/**
 * Pay dates from the job's first through `through` (inclusive): every 14 days; a date the market
 * is closed (a bank holiday on a Friday, July 4) is paid the business day before.
 */
export function usPayDates(job: UsW2Job, through: Ymd): UsPayDate[] {
  const out: UsPayDate[] = [];
  const end = job.to == null ? through : `${job.to}-31` < through ? `${job.to}-31` : through;
  for (let d = job.firstPayDate; d <= end; d = addDays(d, 14)) {
    let paid = d;
    while (!isNyseTradingDay(paid)) paid = addDays(paid, -1);
    out.push({ nominal: d, paid });
  }
  return out;
}

/** The annual salary in effect on `payDate`: a raise every `raiseMonth` once a year has passed. */
export function usAnnualSalary(job: UsW2Job, payDate: Ymd): number {
  const month = monthOf(payDate);
  const mm = String(job.raiseMonth).padStart(2, "0");
  let raises = 0;
  for (let y = Number(job.from.slice(0, 4)); `${y}-${mm}` <= month; y++) {
    if (monthsBetween(job.from, `${y}-${mm}`) >= 12) raises += 1;
  }
  return Math.round(job.annualSalaryUsd * Math.pow(1 + job.yearlyRaise, raises));
}

/** Year-to-date state the next stub needs (per calendar year of the pay date). */
export type UsPayrollYtd = { year: number; ficaWages: number; supplemental: number; deferrals: number };

export function newUsPayrollYtd(): UsPayrollYtd {
  return { year: 0, ficaWages: 0, supplemental: 0, deferrals: 0 };
}

/**
 * One stub. The bonus rides on the first check of its month (scheduled on or before the 14th),
 * from the job's second year; `ytd` is updated in place.
 */
export function usPayStub(job: UsW2Job, date: UsPayDate, ytd: UsPayrollYtd): UsPayStub {
  const payDate = date.paid;
  const year = Number(payDate.slice(0, 4));
  if (ytd.year !== year) Object.assign(ytd, { year, ficaWages: 0, supplemental: 0, deferrals: 0 });
  const salary = usAnnualSalary(job, payDate);
  const regular = cents(salary / 26);
  const bonusDue =
    job.bonus != null &&
    Number(payDate.slice(5, 7)) === job.bonus.month &&
    Number(date.nominal.slice(8, 10)) <= 14 &&
    monthsBetween(job.from, monthOf(payDate)) >= 11;
  const bonus = bonusDue ? cents(salary * job.bonus!.fraction) : 0;
  const gross = cents(regular + bonus);
  const k401 = cents(Math.min(gross * job.retirement401kRate, Math.max(0, usTaxYear(year).elective401kLimit - ytd.deferrals)));
  const match = k401 > 0 ? cents(gross * job.employerMatchRate) : 0;
  const medical = job.medicalUsd;
  const dentalVision = job.dentalVisionUsd;
  const hsa = job.hsaUsd;
  const cafeteria = cents(medical + dentalVision + hsa);
  const ficaWages = cents(gross - cafeteria);
  const socialSecurity = usSocialSecurityTax(ficaWages, ytd.ficaWages, year);
  const medicare = usMedicareTax(ficaWages, ytd.ficaWages, year);
  // Pre-tax deductions come out of regular wages first (as the payslip checks read a stub).
  const regularTaxable = cents(regular - k401 - cafeteria);
  const supplementalTaxable = cents(bonus + Math.min(0, regularTaxable));
  const federal = cents(
    usPercentageMethodWithholding(Math.max(0, regularTaxable), job.payFrequency, job.w4FilingStatus, year) +
      usSupplementalWithholding(supplementalTaxable, ytd.supplemental, year)
  );
  ytd.ficaWages = cents(ytd.ficaWages + ficaWages);
  ytd.supplemental = cents(ytd.supplemental + supplementalTaxable);
  ytd.deferrals = cents(ytd.deferrals + k401);

  const deductions = cents(federal + socialSecurity + medicare + k401 + medical + dentalVision + hsa);
  const lines: UsPayStubLine[] = [{ side: "haber", label: "Regular Pay", amount: regular }];
  if (bonus > 0) lines.push({ side: "haber", label: "Bonus", amount: bonus });
  lines.push(
    { side: "descuento", label: "Federal Income Tax", amount: federal },
    { side: "descuento", label: "Social Security", amount: socialSecurity },
    { side: "descuento", label: "Medicare", amount: medicare }
  );
  if (k401 > 0) lines.push({ side: "descuento", label: "401(k)", amount: k401 });
  lines.push(
    { side: "descuento", label: "Medical", amount: medical },
    { side: "descuento", label: "Dental", amount: dentalVision },
    { side: "descuento", label: "HSA", amount: hsa }
  );
  if (match > 0) lines.push({ side: "memo", label: "401(k) Employer Match", amount: match });
  // The two weeks worked: Monday to the Sunday five days before the scheduled pay date.
  const periodEnd = addDays(date.nominal, -5);
  return {
    job,
    payDate,
    periodStart: addDays(periodEnd, -13),
    periodEnd,
    regular,
    bonus,
    federal,
    socialSecurity,
    medicare,
    k401,
    match,
    medical,
    dentalVision,
    hsa,
    gross,
    deductions,
    net: cents(gross - deductions),
    lines,
  };
}

/** A year's W-2, from its stubs: the boxes the 1040 reads. */
export type UsW2 = {
  year: number;
  employer: string;
  ein: string;
  /** Box 1: wages less the pre-tax 401(k) and the cafeteria deductions. */
  wages: number;
  /** Box 2. */
  federalWithheld: number;
  /** Box 3 (capped at the wage base) and box 5. */
  socialSecurityWages: number;
  /** Box 4. */
  socialSecurityTax: number;
  medicareWages: number;
  /** Box 6. */
  medicareTax: number;
  /** Box 12 code D (401(k) deferrals) and code W (HSA through the cafeteria plan). */
  box12D: number;
  box12W: number;
};

export function usW2sFromStubs(stubs: readonly UsPayStub[]): UsW2[] {
  const byKey = new Map<string, UsW2>();
  for (const s of stubs) {
    const year = Number(s.payDate.slice(0, 4));
    const key = `${s.job.ein}|${year}`;
    let w = byKey.get(key);
    if (!w) {
      w = { year, employer: s.job.employer, ein: s.job.ein, wages: 0, federalWithheld: 0, socialSecurityWages: 0, socialSecurityTax: 0, medicareWages: 0, medicareTax: 0, box12D: 0, box12W: 0 };
      byKey.set(key, w);
    }
    const cafeteria = cents(s.medical + s.dentalVision + s.hsa);
    w.wages = cents(w.wages + s.gross - s.k401 - cafeteria);
    w.federalWithheld = cents(w.federalWithheld + s.federal);
    w.socialSecurityWages = cents(Math.min(usTaxYear(year).socialSecurityWageBase, w.socialSecurityWages + s.gross - cafeteria));
    w.socialSecurityTax = cents(w.socialSecurityTax + s.socialSecurity);
    w.medicareWages = cents(w.medicareWages + s.gross - cafeteria);
    w.medicareTax = cents(w.medicareTax + s.medicare);
    w.box12D = cents(w.box12D + s.k401);
    w.box12W = cents(w.box12W + s.hsa);
  }
  return [...byKey.values()].sort((a, b) => a.year - b.year);
}
