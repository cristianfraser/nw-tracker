/**
 * Each salary payslip recomputed from the law's arithmetic and the month's parameters
 * (`payroll_parameters`, Previred), against what it printed. Nothing is refused: what was paid is
 * what was paid, and a difference is shown for the tax return to settle.
 *
 * - `taxable_base`: min(taxable pay, pension/health cap × the month's UF) vs the printed base.
 * - `pension`: the base × the published rate of the payslip's AFP (10 % + commission) vs the AFP line.
 * - `health_minimum`: 7 % of the base vs the health lines (only a shortfall is a difference).
 * - `unemployment`: the indefinite-contract worker rate × min(taxable pay, its cap × UF), when the
 *   payslip charges any (a fixed-term contract's worker pays none).
 * - `income_tax`: the monthly brackets (the annual table's factors in UTM) on the payslip's own
 *   taxable amount — taxable pay less the pension line, health up to 7 % of the base and the
 *   unemployment line — vs the tax line.
 * - `pension_credited`: the base × (10 % + the employer's share into the account) vs the AFP credits
 *   whose only period is the month (a credit that pays several months cannot be split).
 *
 * Peso payslips of kind salary only (a finiquito and the USD contract have none of these).
 *
 * A US W-2 pay stub is checked against the federal law of its pay date's year (`usLegalParameters.ts`),
 * in dollars, its year-to-date read from the stored stubs before it (by pay date):
 * - `social_security_tax`: 6,2 % of the FICA wages (gross less the cafeteria-plan deductions:
 *   medical, dental/vision, HSA) up to what the employer's year still leaves under the wage base.
 * - `medicare_tax`: 1,45 % of the FICA wages plus 0,9 % on the employer's year above $200.000.
 * - `federal_withholding`: Pub. 15-T's percentage method for the stub's W-4 filing status and pay
 *   frequency on the regular wages (wages less the pre-tax 401(k) and the cafeteria-plan
 *   deductions) plus the flat supplemental rate on bonuses and RSU vests; a difference of up to a
 *   dollar is the employer rounding to the dollar, as Pub. 15-T allows.
 * - `deferral_limit`: the stub's 401(k) deferrals (pre-tax + Roth) against what the year's
 *   elective-deferral limit still leaves (catch-up not counted: the app does not know the age).
 */
import { accountProfileOptional } from "./accountProfile.js";
import { db } from "./db.js";
import { iuscTax, MANDATORY_PENSION_RATE } from "./legalParameters.js";
import { loadPayrollParameters } from "./payrollParametersApply.js";
import { iuscTaxableClp, legalHealthClp, payslipHaberIsTaxable, type PayslipLineKind, type PayslipLineSide } from "./payslipLineKinds.js";
import {
  US_PAY_PERIODS_PER_YEAR,
  usMedicareTax,
  usPercentageMethodWithholding,
  usSocialSecurityTax,
  usSupplementalWithholding,
  usTaxYear,
  type UsFilingStatus,
  type UsPayFrequency,
} from "./usLegalParameters.js";

export const PAYSLIP_CHECKS = [
  "taxable_base",
  "pension",
  "health_minimum",
  "unemployment",
  "income_tax",
  "pension_credited",
  "social_security_tax",
  "medicare_tax",
  "federal_withholding",
  "deferral_limit",
] as const;
export type PayslipCheckName = (typeof PAYSLIP_CHECKS)[number];

export type PayslipCheck = { check: PayslipCheckName; expected: number; printed: number; difference: number };

export type PayslipChecksRow = {
  payslip_id: number;
  period_month: string;
  jurisdiction: "cl" | "us";
  /** The currency the checks' amounts are in: pesos for a liquidación, dollars for a US pay stub. */
  currency: "clp" | "usd"; // convention-ok: a liquidación's checks are pesos, a US stub's dollars
  pension_fund: string | null;
  origin: "document" | "rebuilt";
  checks: PayslipCheck[];
  /** The checks off by more than their rounding (a peso; a cent for FICA, a dollar for the US withholding). */
  differences: PayslipCheck[];
  /** The month's parameters are not published yet (Previred publishes early the next month). */
  pending: boolean;
};


type PayslipRow = {
  id: number;
  period_month: string;
  pension_fund: string | null;
  origin: "document" | "rebuilt";
  total_imponible_clp: number | null;
};

type LineRow = { payslip_id: number; side: PayslipLineSide; section: string | null; kind: PayslipLineKind | null; amount: number };

function loadLinesByPayslip(): Map<number, LineRow[]> {
  const linesBy = new Map<number, LineRow[]>();
  for (const l of db.prepare(`SELECT payslip_id, side, section, kind, amount FROM payslip_lines`).all() as LineRow[]) {
    const list = linesBy.get(l.payslip_id) ?? [];
    list.push(l);
    linesBy.set(l.payslip_id, list);
  }
  return linesBy;
}

/** Every payslip's checks, Chilean and US, by period then id. */
export function buildPayslipChecks(): PayslipChecksRow[] {
  const linesBy = loadLinesByPayslip();
  return [...buildClPayslipChecks(linesBy), ...buildUsPayslipChecks(linesBy)].sort(
    (a, b) => a.period_month.localeCompare(b.period_month) || a.payslip_id - b.payslip_id
  );
}

function buildClPayslipChecks(linesBy: Map<number, LineRow[]>): PayslipChecksRow[] {
  const params = loadPayrollParameters();
  const latestParamsMonth = [...params.keys()].sort().at(-1) ?? "";
  const payslips = db
    .prepare(
      `SELECT id, period_month, pension_fund, origin, total_imponible_clp FROM payroll_work_earnings
        WHERE jurisdiction = 'cl' AND earning_type = 'salary' AND liquido_currency = 'clp' ORDER BY period_month, id`
    )
    .all() as PayslipRow[];
  const creditedByMonth = new Map<string, number>();
  for (const r of db
    .prepare(
      `SELECT p.period_month, m.account_id, m.amount FROM pension_contribution_periods p JOIN movements m ON m.id = p.movement_id
        WHERE (SELECT COUNT(*) FROM pension_contribution_periods x WHERE x.movement_id = p.movement_id) = 1 AND m.account_id IS NOT NULL`
    )
    .all() as { period_month: string; account_id: number; amount: number }[]) {
    if (accountProfileOptional(r.account_id)?.kind !== "afp") continue;
    creditedByMonth.set(r.period_month, (creditedByMonth.get(r.period_month) ?? 0) + r.amount);
  }

  const out: PayslipChecksRow[] = [];
  for (const p of payslips) {
    const m = params.get(p.period_month);
    if (!m) {
      // Previred publishes a month's indicators early the next month: a payslip newer than the
      // newest published month waits; an older month without them is missing data.
      if (p.period_month > latestParamsMonth) {
        out.push({ payslip_id: p.id, period_month: p.period_month, jurisdiction: "cl", currency: "clp", pension_fund: p.pension_fund, origin: p.origin, checks: [], differences: [], pending: true });
        continue;
      }
      throw new Error(`payslip checks: no payroll parameters for ${p.period_month} — run import:previred-indicators`);
    }
    const lines = linesBy.get(p.id) ?? [];
    const sum = (side: "haber" | "descuento", kinds: readonly PayslipLineKind[]) =>
      lines.filter((l) => l.side === side && l.kind != null && kinds.includes(l.kind)).reduce((s, l) => s + l.amount, 0);
    const taxablePay = lines.filter(payslipHaberIsTaxable).reduce((s, l) => s + l.amount, 0);
    const base = Math.min(taxablePay, Math.round(m.pension_cap_uf * m.uf));
    const pensionLine = sum("descuento", ["pension"]);
    const healthLines = sum("descuento", ["health", "health_additional"]);
    const unemploymentLine = sum("descuento", ["unemployment"]);
    const taxLine = sum("descuento", ["income_tax"]);
    const checks: PayslipCheck[] = [];
    const add = (check: PayslipCheckName, expected: number, printed: number) =>
      checks.push({ check, expected, printed, difference: printed - expected });

    if (p.total_imponible_clp != null) add("taxable_base", base, p.total_imponible_clp);
    if (pensionLine > 0) {
      if (!p.pension_fund) throw new Error(`payslip ${p.id} (${p.period_month}): an AFP line but no AFP named`);
      const rate = m.afp_worker_rates[p.pension_fund];
      if (rate == null) throw new Error(`payslip checks: no ${p.pension_fund} rate for ${p.period_month}`);
      add("pension", Math.round((base * rate) / 100), pensionLine);
    }
    const healthMin = legalHealthClp(base);
    add("health_minimum", healthMin, healthLines < healthMin ? healthLines : healthMin);
    if (unemploymentLine > 0) {
      const afcBase = Math.min(taxablePay, Math.round(m.unemployment_cap_uf * m.uf));
      add("unemployment", Math.round((afcBase * m.afc_worker_rate) / 100), unemploymentLine);
    }
    const taxable = iuscTaxableClp({ taxablePay, pension: pensionLine, healthPaid: healthLines, unemployment: unemploymentLine, taxableBase: base });
    const incomeYear = Number(p.period_month.slice(0, 4));
    add("income_tax", Math.round(iuscTax(taxable, m.utm, incomeYear)), taxLine);
    const credited = creditedByMonth.get(p.period_month);
    if (credited != null) add("pension_credited", Math.round((base * (MANDATORY_PENSION_RATE * 100 + m.afp_employer_rate)) / 100), credited);

    out.push({
      payslip_id: p.id,
      period_month: p.period_month,
      jurisdiction: "cl",
      currency: "clp",
      pension_fund: p.pension_fund,
      origin: p.origin,
      checks,
      differences: checks.filter((c) => Math.abs(c.difference) > 1),
      pending: false,
    });
  }
  return out;
}

type UsPayslipRow = {
  id: number;
  period_month: string;
  employer_name: string;
  employer_rut: string | null;
  pay_date: string | null;
  pay_period: string;
  w4_filing_status: UsFilingStatus | null;
  origin: "document" | "rebuilt";
};

/** Rounding each US check allows: FICA to the cent, the withholding to the dollar (Pub. 15-T lets the employer round). */
const US_TOLERANCE: Partial<Record<PayslipCheckName, number>> = {
  social_security_tax: 0.005,
  medicare_tax: 0.005,
  federal_withholding: 1.005,
  deferral_limit: 0.005,
};

function cents(x: number): number {
  return Math.round(x * 100) / 100;
}

function buildUsPayslipChecks(linesBy: Map<number, LineRow[]>): PayslipChecksRow[] {
  const payslips = db
    .prepare(
      `SELECT id, period_month, employer_name, employer_rut, pay_date, pay_period, w4_filing_status, origin
         FROM payroll_work_earnings WHERE jurisdiction = 'us' ORDER BY pay_date, id`
    )
    .all() as UsPayslipRow[];
  // Year-to-date before each stub: FICA wages and supplemental wages per employer, 401(k) deferrals per person.
  const ficaYtd = new Map<string, number>();
  const supplementalYtd = new Map<string, number>();
  const deferralYtd = new Map<number, number>();
  const out: PayslipChecksRow[] = [];
  for (const p of payslips) {
    if (p.pay_date == null || p.w4_filing_status == null) throw new Error(`payslip ${p.id}: a US payslip without its pay date or W-4 filing status`);
    if (!(p.pay_period in US_PAY_PERIODS_PER_YEAR)) throw new Error(`payslip ${p.id}: a US payslip paid ${p.pay_period}`);
    const year = Number(p.pay_date.slice(0, 4));
    const employerYear = `${p.employer_rut ?? p.employer_name}|${year}`;
    const lines = linesBy.get(p.id) ?? [];
    const sum = (kinds: readonly PayslipLineKind[]) =>
      cents(lines.filter((l) => l.side !== "memo" && l.kind != null && kinds.includes(l.kind)).reduce((s, l) => s + l.amount, 0));
    const wages = sum(["wages"]);
    const supplemental = sum(["supplemental_bonus", "rsu"]);
    const cafeteria = sum(["health_premium", "dental_vision", "hsa"]);
    const pretax401k = sum(["retirement_401k_pretax"]);
    const deferrals = sum(["retirement_401k_pretax", "retirement_401k_roth"]);
    const ficaWages = cents(wages + supplemental - cafeteria);
    // Pre-tax deductions come out of regular wages first; what they exceed reduces the supplemental wages.
    const regular = cents(wages - pretax401k - cafeteria);
    const supplementalTaxable = cents(supplemental + Math.min(0, regular));

    const checks: PayslipCheck[] = [];
    const add = (check: PayslipCheckName, expected: number, printed: number) =>
      checks.push({ check, expected: cents(expected), printed: cents(printed), difference: cents(printed - expected) });
    const priorFica = ficaYtd.get(employerYear) ?? 0;
    const priorSupplemental = supplementalYtd.get(employerYear) ?? 0;
    add("social_security_tax", usSocialSecurityTax(ficaWages, priorFica, year), sum(["social_security_tax"]));
    add("medicare_tax", usMedicareTax(ficaWages, priorFica, year), sum(["medicare_tax"]));
    add(
      "federal_withholding",
      usPercentageMethodWithholding(Math.max(0, regular), p.pay_period as UsPayFrequency, p.w4_filing_status, year) +
        usSupplementalWithholding(supplementalTaxable, priorSupplemental, year),
      sum(["federal_income_tax"])
    );
    const priorDeferrals = deferralYtd.get(year) ?? 0;
    if (deferrals > 0) {
      add("deferral_limit", Math.min(deferrals, Math.max(0, usTaxYear(year).elective401kLimit - priorDeferrals)), deferrals);
    }
    ficaYtd.set(employerYear, priorFica + ficaWages);
    supplementalYtd.set(employerYear, priorSupplemental + supplementalTaxable);
    deferralYtd.set(year, priorDeferrals + deferrals);

    out.push({
      payslip_id: p.id,
      period_month: p.period_month,
      jurisdiction: "us",
      currency: "usd",
      pension_fund: null,
      origin: p.origin,
      checks,
      differences: checks.filter((c) => Math.abs(c.difference) > (US_TOLERANCE[c.check] ?? 0.005)),
      pending: false,
    });
  }
  return out;
}

export type PayrollWithholdingYear = {
  income_year: number;
  payslips: number;
  /** Σ the tax lines the payslips printed. */
  withheld: number;
  /** Σ the tax the monthly table gives on each payslip's taxable amount. */
  by_table: number;
  difference: number;
  months_with_differences: string[];
};

export type PayrollWithholdingMonth = {
  payslip_id: number;
  period_month: string;
  origin: "document" | "rebuilt";
  withheld: number;
  by_table: number;
  difference: number;
};

/** One row per Chilean salary payslip of the year: the impuesto único it withheld against the table's. */
export function payrollWithholdingMonths(incomeYear: number, checks = buildPayslipChecks()): PayrollWithholdingMonth[] {
  return checks
    .filter((c) => c.jurisdiction === "cl" && c.period_month.startsWith(`${incomeYear}-`) && !c.pending)
    .map((c) => {
      const t = c.checks.find((x) => x.check === "income_tax")!;
      return { payslip_id: c.payslip_id, period_month: c.period_month, origin: c.origin, withheld: t.printed, by_table: t.expected, difference: t.difference };
    });
}

/** A year's impuesto único withheld against the table, from the Chilean payslip checks. */
export function payrollWithholdingYear(incomeYear: number, checks = buildPayslipChecks()): PayrollWithholdingYear {
  const rows = checks.filter((c) => c.jurisdiction === "cl" && c.period_month.startsWith(`${incomeYear}-`));
  let withheld = 0;
  let byTable = 0;
  const months: string[] = [];
  for (const r of rows) {
    const t = r.checks.find((c) => c.check === "income_tax");
    if (!t) continue;
    withheld += t.printed;
    byTable += t.expected;
    if (Math.abs(t.difference) > 1) months.push(r.period_month);
  }
  return { income_year: incomeYear, payslips: rows.length, withheld, by_table: byTable, difference: withheld - byTable, months_with_differences: months };
}
