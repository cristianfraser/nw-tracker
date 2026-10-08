/**
 * Gross pay → every deduction → net pay, from the payslips' printed lines (`payslip_lines`), per
 * payslip and summed per month and per year — the income page's «Bruto vs líquido».
 *
 * Gross is split into taxable pay, non-taxable allowances, indemnities and contractor fees by the
 * lines' kinds; the printed AFP line into the mandatory 10 % of the taxable base and the AFP's
 * commission (`splitPensionLine`). Every value comes in pesos and dollars, converted per payslip:
 * a peso payslip at the buy rate on its pay day (the paired deposit's day, else the month's last
 * day), a dollar payslip (the 2021 contract) at the rate its stored peso breakdown used. A payslip's
 * deductions add up to gross − net, or the build throws.
 */
import { db } from "./db.js";
import { clpToUsdAtPayment } from "./fxRates.js";
import { splitPensionLine, type PayslipLineKind } from "./payslipLineKinds.js";

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
  /** Insurance + fees + a finiquito's combined contributions + advances: the deductions with no column of their own. */
  "other_deductions",
  "deductions",
  "net",
] as const;

export type PayrollBreakdownField = (typeof PAYROLL_BREAKDOWN_FIELDS)[number];
export type PayrollAmount = { clp: number; usd: number };
export type PayrollBreakdownValues = Record<PayrollBreakdownField, PayrollAmount>;

export type PayrollBreakdownPayslip = {
  payslip_id: number;
  period_month: string;
  employer_name: string;
  earning_type: "salary" | "severance";
  origin: "document" | "rebuilt";
  values: PayrollBreakdownValues;
};

export type PayrollBreakdownRow = { period: string; payslips: number; values: PayrollBreakdownValues };

export type PayrollBreakdownPayload = {
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
};

type PayslipRow = {
  id: number;
  period_month: string;
  employer_name: string;
  earning_type: "salary" | "severance";
  origin: "document" | "rebuilt";
  liquido: number;
  liquido_currency: "clp" | "usd";
  total_imponible_clp: number | null;
  total_haberes_clp: number | null;
  paid_on: string | null;
};

type LineRow = { payslip_id: number; side: "haber" | "descuento"; kind: PayslipLineKind | null; amount: number };

function zero(): PayrollBreakdownValues {
  return Object.fromEntries(PAYROLL_BREAKDOWN_FIELDS.map((f) => [f, { clp: 0, usd: 0 }])) as PayrollBreakdownValues;
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
    if (l.side === "haber") {
      const g = GROSS_GROUP[l.kind];
      if (!g) throw new Error(`payslip ${p.id}: the haber kind ${l.kind} has no gross group`);
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
  v.other_deductions = v.insurance + v.fees + v.social_security + v.advance;
  v.net = v.gross - v.deductions;
  if (Math.abs(v.net - p.liquido) > 0.005) {
    throw new Error(`payslip ${p.id}: gross − deductions = ${v.net}, net pay ${p.liquido}`);
  }
  return v;
}

export function buildPayrollBreakdown(): PayrollBreakdownPayload {
  const payslipRows = db
    .prepare(
      `SELECT p.id, p.period_month, p.employer_name, p.earning_type, p.origin, p.liquido, p.liquido_currency,
              p.total_imponible_clp, p.total_haberes_clp, m.occurred_on AS paid_on
         FROM payroll_work_earnings p LEFT JOIN movements m ON m.id = p.movement_id
        ORDER BY p.period_month, p.id`
    )
    .all() as PayslipRow[];
  const linesBy = new Map<number, LineRow[]>();
  for (const l of db.prepare(`SELECT payslip_id, side, kind, amount FROM payslip_lines ORDER BY payslip_id, position`).all() as LineRow[]) {
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
    if (p.liquido_currency === "usd") {
      if (p.total_haberes_clp == null || !(native.gross > 0)) throw new Error(`payslip ${p.id}: a dollar payslip without its peso gross`);
      const rate = p.total_haberes_clp / native.gross;
      for (const f of PAYROLL_BREAKDOWN_FIELDS) values[f] = { clp: native[f] * rate, usd: native[f] };
    } else {
      const day = p.paid_on ?? monthEnd(p.period_month);
      const perClp = clpToUsdAtPayment(1_000_000, day);
      if (perClp == null) throw new Error(`payslip ${p.id}: no USD rate on or before ${day}`);
      for (const f of PAYROLL_BREAKDOWN_FIELDS) values[f] = { clp: native[f], usd: (native[f] * perClp) / 1_000_000 };
    }
    payslips.push({
      payslip_id: p.id,
      period_month: p.period_month,
      employer_name: p.employer_name,
      earning_type: p.earning_type,
      origin: p.origin,
      values,
    });
  }

  const sumBy = (key: (p: PayrollBreakdownPayslip) => string): PayrollBreakdownRow[] => {
    const rows = new Map<string, PayrollBreakdownRow>();
    for (const p of payslips) {
      const k = key(p);
      const row = rows.get(k) ?? { period: k, payslips: 0, values: zero() };
      row.payslips += 1;
      for (const f of PAYROLL_BREAKDOWN_FIELDS) {
        row.values[f].clp += p.values[f].clp;
        row.values[f].usd += p.values[f].usd;
      }
      rows.set(k, row);
    }
    return [...rows.values()].sort((a, b) => a.period.localeCompare(b.period));
  };
  return { payslips, months: sumBy((p) => p.period_month), years: sumBy((p) => p.period_month.slice(0, 4)) };
}
