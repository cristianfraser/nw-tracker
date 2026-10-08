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
 */
import { db } from "./db.js";
import { accountKindSlugForAccountId } from "./accountBucket.js";
import { igcTax } from "./f22Draft.js";
import { loadPayrollParameters } from "./payrollParametersApply.js";
import type { PayslipLineKind } from "./payslipLineKinds.js";

export const PAYSLIP_CHECKS = ["taxable_base", "pension", "health_minimum", "unemployment", "income_tax", "pension_credited"] as const;
export type PayslipCheckName = (typeof PAYSLIP_CHECKS)[number];

export type PayslipCheck = { check: PayslipCheckName; expected: number; printed: number; difference: number };

export type PayslipChecksRow = {
  payslip_id: number;
  period_month: string;
  pension_fund: string | null;
  origin: "document" | "rebuilt";
  checks: PayslipCheck[];
  /** The checks off by more than a peso (rounding). */
  differences: PayslipCheck[];
  /** The month's parameters are not published yet (Previred publishes early the next month). */
  pending: boolean;
};

const TAXABLE_KINDS = new Set<PayslipLineKind>(["base_salary", "gratification", "bonus", "life_insurance_benefit", "absence"]);
const LEGAL_HEALTH_RATE = 0.07;
const MANDATORY_PENSION_RATE = 10;

type PayslipRow = {
  id: number;
  period_month: string;
  pension_fund: string | null;
  origin: "document" | "rebuilt";
  total_imponible_clp: number | null;
};

type LineRow = { payslip_id: number; side: "haber" | "descuento"; section: string | null; kind: PayslipLineKind | null; amount: number };

/** Taxable pay: the haberes the payslip prints as imponible, or by kind when it prints no section. */
function isTaxableHaber(l: LineRow): boolean {
  if (l.side !== "haber") return false;
  if (l.section === "imponible") return true;
  if (l.section === "no_imponible") return false;
  return l.kind != null && TAXABLE_KINDS.has(l.kind);
}

export function buildPayslipChecks(): PayslipChecksRow[] {
  const params = loadPayrollParameters();
  const latestParamsMonth = [...params.keys()].sort().at(-1) ?? "";
  const payslips = db
    .prepare(
      `SELECT id, period_month, pension_fund, origin, total_imponible_clp FROM payroll_work_earnings
        WHERE earning_type = 'salary' AND liquido_currency = 'clp' ORDER BY period_month, id`
    )
    .all() as PayslipRow[];
  const linesBy = new Map<number, LineRow[]>();
  for (const l of db.prepare(`SELECT payslip_id, side, section, kind, amount FROM payslip_lines`).all() as LineRow[]) {
    const list = linesBy.get(l.payslip_id) ?? [];
    list.push(l);
    linesBy.set(l.payslip_id, list);
  }
  // AFP credits that pay exactly one month.
  const creditedByMonth = new Map<string, number>();
  for (const r of db
    .prepare(
      `SELECT p.period_month, m.account_id, m.amount FROM pension_contribution_periods p JOIN movements m ON m.id = p.movement_id
        WHERE (SELECT COUNT(*) FROM pension_contribution_periods x WHERE x.movement_id = p.movement_id) = 1 AND m.account_id IS NOT NULL`
    )
    .all() as { period_month: string; account_id: number; amount: number }[]) {
    if (accountKindSlugForAccountId(r.account_id) !== "afp") continue;
    creditedByMonth.set(r.period_month, (creditedByMonth.get(r.period_month) ?? 0) + r.amount);
  }

  const out: PayslipChecksRow[] = [];
  for (const p of payslips) {
    const m = params.get(p.period_month);
    if (!m) {
      // Previred publishes a month's indicators early the next month: a payslip newer than the
      // newest published month waits; an older month without them is missing data.
      if (p.period_month > latestParamsMonth) {
        out.push({ payslip_id: p.id, period_month: p.period_month, pension_fund: p.pension_fund, origin: p.origin, checks: [], differences: [], pending: true });
        continue;
      }
      throw new Error(`payslip checks: no payroll parameters for ${p.period_month} — run import:previred-indicators`);
    }
    const lines = linesBy.get(p.id) ?? [];
    const sum = (side: "haber" | "descuento", kinds: readonly PayslipLineKind[]) =>
      lines.filter((l) => l.side === side && l.kind != null && kinds.includes(l.kind)).reduce((s, l) => s + l.amount, 0);
    const taxablePay = lines.filter(isTaxableHaber).reduce((s, l) => s + l.amount, 0);
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
    const healthMin = Math.round(base * LEGAL_HEALTH_RATE);
    add("health_minimum", healthMin, healthLines < healthMin ? healthLines : healthMin);
    if (unemploymentLine > 0) {
      const afcBase = Math.min(taxablePay, Math.round(m.unemployment_cap_uf * m.uf));
      add("unemployment", Math.round((afcBase * m.afc_worker_rate) / 100), unemploymentLine);
    }
    const taxable = taxablePay - pensionLine - Math.min(healthLines, healthMin) - unemploymentLine;
    const incomeYear = Number(p.period_month.slice(0, 4));
    add("income_tax", Math.round(igcTax(taxable, m.utm, incomeYear + 1)), taxLine);
    const credited = creditedByMonth.get(p.period_month);
    if (credited != null) add("pension_credited", Math.round((base * (MANDATORY_PENSION_RATE + m.afp_employer_rate)) / 100), credited);

    out.push({
      payslip_id: p.id,
      period_month: p.period_month,
      pension_fund: p.pension_fund,
      origin: p.origin,
      checks,
      differences: checks.filter((c) => Math.abs(c.difference) > 1),
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

/** One row per salary payslip of the year: the tax it withheld against the table's. */
export function payrollWithholdingMonths(incomeYear: number, checks = buildPayslipChecks()): PayrollWithholdingMonth[] {
  return checks
    .filter((c) => c.period_month.startsWith(`${incomeYear}-`) && !c.pending)
    .map((c) => {
      const t = c.checks.find((x) => x.check === "income_tax")!;
      return { payslip_id: c.payslip_id, period_month: c.period_month, origin: c.origin, withheld: t.printed, by_table: t.expected, difference: t.difference };
    });
}

/** A year's withheld tax against the table, from the payslip checks. */
export function payrollWithholdingYear(incomeYear: number, checks = buildPayslipChecks()): PayrollWithholdingYear {
  const rows = checks.filter((c) => c.period_month.startsWith(`${incomeYear}-`));
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
