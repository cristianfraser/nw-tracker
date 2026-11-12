/**
 * Gross pay → every deduction → net pay, from the payslips' printed lines (`payslip_lines`), per
 * payslip and summed per month and per year — the income page's «Bruto vs líquido».
 *
 * Gross is split into taxable pay, non-taxable allowances, indemnities and contractor fees by the
 * lines' kinds; the printed AFP line into the mandatory 10 % of the taxable base and the AFP's
 * commission (`splitPensionLine`). A US pay stub's deductions fall into the same groups where they
 * are the same thing (federal withholding → income tax, premiums → health) and into their own where
 * not (Social Security + Medicare, the 401(k), the HSA, RSUs paid in shares — counted in «other
 * deductions» so the stack still adds to gross); its employer 401(k) match is a memo line, shown
 * apart (`employer_retirement`) and outside gross − deductions = net.
 *
 * Every value comes in the requested display unit, converted per payslip: in pesos a dollar payslip
 * at the rate its stored peso breakdown used (the 2021 contract) or, for a US pay stub, the mid on
 * its pay date (`usPayslipClpPerUsd`); in dollars a peso payslip at the buy rate on its pay day (the
 * paired deposit's day, else the month's last day); in any other unit the payslip's own currency at
 * that day's mid (`rates.ts`). A payslip's deductions add up to gross − net, or the build throws.
 */
import { db } from "./db.js";
import { clpToUsdAtPayment } from "./fxRates.js";
import { payslipHaberIsTaxable, splitPensionLine, type PayrollJurisdiction, type PayslipLineKind, type PayslipLineSide } from "./payslipLineKinds.js";
import { usPayslipClpPerUsd } from "./payrollUsdRate.js";
import { convertCurrency } from "./rates.js";

export const PAYROLL_BREAKDOWN_FIELDS = [
  "gross",
  "gross_taxable",
  "gross_non_taxable",
  "gross_indemnities",
  "gross_contractor",
  "pension",
  "pension_commission",
  "health",
  "unemployment",
  "income_tax",
  "voluntary_pension",
  "social_security",
  "insurance",
  "fees",
  "advance",
  /** US: Social Security + Medicare (FICA), the employee's share. */
  "social_security_medicare",
  /** US: 401(k) deferrals, pre-tax and Roth. */
  "retirement_401k",
  /** US: HSA contributions. */
  "hsa",
  /** US: vested RSUs delivered as shares, not cash. */
  "stock_paid",
  /** Insurance + fees + a finiquito's combined contributions + advances + shares paid: the deductions with no column of their own. */
  "other_deductions",
  "deductions",
  "net",
  /** US: the employer's 401(k) match (a memo line: not gross pay, not a deduction; outside gross − deductions = net). */
  "employer_retirement",
] as const;

export type PayrollBreakdownField = (typeof PAYROLL_BREAKDOWN_FIELDS)[number];
/** Every field's amount in the payload's unit. */
export type PayrollBreakdownValues = Record<PayrollBreakdownField, number>;

export type PayrollBreakdownPayslip = {
  payslip_id: number;
  period_month: string;
  employer_name: string;
  earning_type: "salary" | "severance";
  origin: "document" | "rebuilt";
  jurisdiction: PayrollJurisdiction;
  values: PayrollBreakdownValues;
};

export type PayrollBreakdownRow = { period: string; payslips: number; values: PayrollBreakdownValues };

export type PayrollBreakdownPayload = {
  /** The display unit every value is in. */
  unit: string;
  payslips: PayrollBreakdownPayslip[];
  /** One row per payroll month (YYYY-MM), oldest first. */
  months: PayrollBreakdownRow[];
  /** One row per year (YYYY), oldest first. */
  years: PayrollBreakdownRow[];
};

const GROSS_GROUP: Partial<Record<PayslipLineKind, PayrollBreakdownField>> = {
  base_salary: "gross_taxable",
  gratification: "gross_taxable",
  bonus: "gross_taxable",
  life_insurance_benefit: "gross_taxable",
  absence: "gross_taxable",
  allowance: "gross_non_taxable",
  vacation_pay: "gross_indemnities",
  indemnity_notice: "gross_indemnities",
  indemnity_years_of_service: "gross_indemnities",
  indemnity_voluntary: "gross_indemnities",
  contractor_fee: "gross_contractor",
  wages: "gross_taxable",
  supplemental_bonus: "gross_taxable",
  rsu: "gross_taxable",
};

const DEDUCTION_GROUP: Partial<Record<PayslipLineKind, PayrollBreakdownField>> = {
  health: "health",
  health_additional: "health",
  unemployment: "unemployment",
  income_tax: "income_tax",
  voluntary_pension: "voluntary_pension",
  social_security: "social_security",
  life_insurance: "insurance",
  transfer_fee: "fees",
  advance: "advance",
  federal_income_tax: "income_tax",
  social_security_tax: "social_security_medicare",
  medicare_tax: "social_security_medicare",
  retirement_401k_pretax: "retirement_401k",
  retirement_401k_roth: "retirement_401k",
  hsa: "hsa",
  health_premium: "health",
  dental_vision: "health",
  rsu_offset: "stock_paid",
};

const MEMO_GROUP: Partial<Record<PayslipLineKind, PayrollBreakdownField>> = {
  employer_401k_match: "employer_retirement",
};

type PayslipRow = {
  id: number;
  period_month: string;
  employer_name: string;
  earning_type: "salary" | "severance";
  origin: "document" | "rebuilt";
  jurisdiction: PayrollJurisdiction;
  pay_date: string | null;
  liquido: number;
  liquido_currency: "clp" | "usd"; // convention-ok: a liquidación pays pesos, a US stub or contractor wire dollars
  total_imponible_clp: number | null;
  total_haberes_clp: number | null;
  paid_on: string | null;
};

type LineRow = { payslip_id: number; side: PayslipLineSide; section: string | null; kind: PayslipLineKind | null; amount: number };

function zero(): PayrollBreakdownValues {
  return Object.fromEntries(PAYROLL_BREAKDOWN_FIELDS.map((f) => [f, 0])) as PayrollBreakdownValues;
}

function monthEnd(periodMonth: string): string {
  const [y, m] = periodMonth.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

/** One payslip's breakdown in its own currency (pesos, or dollars for a dollar payslip). */
function nativeBreakdown(p: PayslipRow, lines: readonly LineRow[]): Record<PayrollBreakdownField, number> {
  const v = Object.fromEntries(PAYROLL_BREAKDOWN_FIELDS.map((f) => [f, 0])) as Record<PayrollBreakdownField, number>;
  let pension = 0;
  for (const l of lines) {
    if (l.kind == null) throw new Error(`payslip ${p.id}: a line without a kind — re-run the payslip import`);
    if (l.side === "memo") {
      const g = MEMO_GROUP[l.kind];
      if (!g) throw new Error(`payslip ${p.id}: the memo kind ${l.kind} has no group`);
      v[g] += l.amount;
    } else if (l.side === "haber") {
      let g = GROSS_GROUP[l.kind];
      if (!g) throw new Error(`payslip ${p.id}: the haber kind ${l.kind} has no gross group`);
      if (p.jurisdiction === "cl" && (g === "gross_taxable" || g === "gross_non_taxable")) {
        g = payslipHaberIsTaxable(l) ? "gross_taxable" : "gross_non_taxable";
      }
      v[g] += l.amount;
      v.gross += l.amount;
    } else {
      v.deductions += l.amount;
      if (l.kind === "pension") pension += l.amount;
      else {
        const g = DEDUCTION_GROUP[l.kind];
        if (!g) throw new Error(`payslip ${p.id}: the descuento kind ${l.kind} has no deduction group`);
        v[g] += l.amount;
      }
    }
  }
  if (pension !== 0) {
    if (p.total_imponible_clp == null) throw new Error(`payslip ${p.id}: an AFP line without a taxable base to split it`);
    const split = splitPensionLine(pension, p.total_imponible_clp);
    v.pension += split.mandatory;
    v.pension_commission += split.commission;
  }
  v.other_deductions = v.insurance + v.fees + v.social_security + v.advance + v.stock_paid;
  v.net = v.gross - v.deductions;
  if (Math.abs(v.net - p.liquido) > 0.005) {
    throw new Error(`payslip ${p.id}: gross − deductions = ${v.net}, net pay ${p.liquido}`);
  }
  return v;
}

export function buildPayrollBreakdown(unit: string = "clp"): PayrollBreakdownPayload {
  const payslipRows = db
    .prepare(
      `SELECT p.id, p.period_month, p.employer_name, p.earning_type, p.origin, p.jurisdiction, p.pay_date, p.liquido, p.liquido_currency,
              p.total_imponible_clp, p.total_haberes_clp, m.occurred_on AS paid_on
         FROM payroll_work_earnings p LEFT JOIN movements m ON m.id = p.movement_id
        ORDER BY p.period_month, p.id`
    )
    .all() as PayslipRow[];
  const linesBy = new Map<number, LineRow[]>();
  for (const l of db.prepare(`SELECT payslip_id, side, section, kind, amount FROM payslip_lines ORDER BY payslip_id, position`).all() as LineRow[]) {
    const list = linesBy.get(l.payslip_id) ?? [];
    list.push(l);
    linesBy.set(l.payslip_id, list);
  }

  const payslips: PayrollBreakdownPayslip[] = [];
  for (const p of payslipRows) {
    const lines = linesBy.get(p.id);
    if (!lines?.length) throw new Error(`payslip ${p.id} (${p.period_month}) has no lines`);
    const native = nativeBreakdown(p, lines);
    const values = zero();
    // How one unit of the payslip's own currency reads in the requested unit (the rules above).
    // `num / den` per native unit, applied as (native × num) / den so the dollar figures are the
    // ones a peso payslip always had.
    let factor: number;
    let den = 1;
    if (unit === p.liquido_currency) {
      factor = 1;
    } else if (p.jurisdiction === "us" && unit === "clp") { // convention-ok: a liquidación pays pesos, a US stub or contractor wire dollars
      if (p.liquido_currency !== "usd" || p.pay_date == null) throw new Error(`payslip ${p.id}: a US payslip must be in dollars with a pay date`); // convention-ok: a liquidación pays pesos, a US stub or contractor wire dollars
      factor = usPayslipClpPerUsd(p.pay_date, p.id);
    } else if (p.liquido_currency === "usd" && unit === "clp") { // convention-ok: a liquidación pays pesos, a US stub or contractor wire dollars
      if (p.total_haberes_clp == null || !(native.gross > 0)) throw new Error(`payslip ${p.id}: a dollar payslip without its peso gross`);
      factor = p.total_haberes_clp / native.gross;
    } else if (p.liquido_currency === "clp" && unit === "usd") { // convention-ok: a liquidación pays pesos, a US stub or contractor wire dollars
      const day = p.paid_on ?? monthEnd(p.period_month);
      const perClp = clpToUsdAtPayment(1_000_000, day);
      if (perClp == null) throw new Error(`payslip ${p.id}: no USD rate on or before ${day}`);
      factor = perClp;
      den = 1_000_000;
    } else {
      const day = p.pay_date ?? p.paid_on ?? monthEnd(p.period_month);
      const per = convertCurrency(1_000_000, p.liquido_currency, unit, day, { side: "mid" });
      if (per == null) throw new Error(`payslip ${p.id}: no ${p.liquido_currency}→${unit} rate on or before ${day}`);
      factor = per;
      den = 1_000_000;
    }
    if (p.jurisdiction === "us" && (p.liquido_currency !== "usd" || p.pay_date == null)) { // convention-ok: a liquidación pays pesos, a US stub or contractor wire dollars
      throw new Error(`payslip ${p.id}: a US payslip must be in dollars with a pay date`);
    }
    for (const f of PAYROLL_BREAKDOWN_FIELDS) values[f] = factor === 1 && den === 1 ? native[f] : den === 1 ? native[f] * factor : (native[f] * factor) / den;
    payslips.push({
      payslip_id: p.id,
      period_month: p.period_month,
      employer_name: p.employer_name,
      earning_type: p.earning_type,
      origin: p.origin,
      jurisdiction: p.jurisdiction,
      values,
    });
  }

  const sumBy = (key: (p: PayrollBreakdownPayslip) => string): PayrollBreakdownRow[] => {
    const rows = new Map<string, PayrollBreakdownRow>();
    for (const p of payslips) {
      const k = key(p);
      const row = rows.get(k) ?? { period: k, payslips: 0, values: zero() };
      row.payslips += 1;
      for (const f of PAYROLL_BREAKDOWN_FIELDS) row.values[f] += p.values[f];
      rows.set(k, row);
    }
    return [...rows.values()].sort((a, b) => a.period.localeCompare(b.period));
  };
  return { unit, payslips, months: sumBy((p) => p.period_month), years: sumBy((p) => p.period_month.slice(0, 4)) };
}
