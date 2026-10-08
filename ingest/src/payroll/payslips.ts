/**
 * The payroll parser's output (`cfraser/payroll-parsing-output/all.json`, written by
 * `python/parse-payroll-liquidaciones.py`) → one `employment.payslips` payload.
 */
import fs from "node:fs";
import path from "node:path";
import type { EmploymentPayslipsPayload, Payslip, PayslipLine } from "nw-tracker-contracts";
import { resolveCfraserDir } from "../paths.js";

/** One payslip as the parser writes it. */
export type ParsedPayrollRow = {
  source_pdf: string;
  period_month: string;
  employer_name: string;
  employer_rut: string | null;
  pay_period_label: string | null;
  earning_type?: "salary" | "severance";
  base_salary_clp: number | null;
  colacion_clp: number | null;
  movilizacion_clp: number | null;
  gratificacion_clp: number | null;
  total_imponible_clp: number | null;
  total_no_imponible_clp: number | null;
  total_haberes_clp: number | null;
  desc_afp_clp: number | null;
  desc_health_clp: number | null;
  desc_tax_clp: number | null;
  desc_cesantia_clp: number | null;
  desc_apv_clp: number | null;
  desc_other_clp: number | null;
  total_descuentos_clp: number | null;
  liquido_clp: number;
  uf_mes: number | null;
  utm_mes: number | null;
  tope_previsional_uf: number | null;
  tope_cesantia_uf: number | null;
  format?: string;
  lines?: PayslipLine[];
};

export type PayrollParseIndex = { parser_version?: string; rows?: ParsedPayrollRow[]; failures?: unknown[] | number };

export function payrollParseIndexPath(): string {
  return path.join(resolveCfraserDir(), "payroll-parsing-output", "all.json");
}

/** Reads the parser's index; throws when it is missing, recorded failures, or holds no payslip. */
export function readPayrollParseIndex(file = payrollParseIndexPath()): { parser_version: string; rows: ParsedPayrollRow[] } {
  if (!fs.existsSync(file)) throw new Error(`missing ${file} — run npm run parse:payroll-liquidaciones first`);
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as PayrollParseIndex;
  const failures = Array.isArray(raw.failures) ? raw.failures.length : (raw.failures ?? 0);
  if (failures > 0) throw new Error(`${file} records ${failures} failure(s) — fix them and re-run parse:payroll-liquidaciones`);
  if (!raw.rows?.length) throw new Error(`no parsed payslips in ${file}`);
  return { parser_version: raw.parser_version ?? "unknown", rows: raw.rows };
}

export function payslipFromParsedRow(r: ParsedPayrollRow): Payslip {
  if (!r.lines?.length) throw new Error(`${r.source_pdf}: no lines in the parse — re-run parse:payroll-liquidaciones`);
  return {
    document: r.source_pdf,
    period_month: r.period_month,
    employer: { name: r.employer_name, rut: r.employer_rut },
    pay_period_label: r.pay_period_label,
    kind: r.earning_type ?? "salary",
    earnings: {
      base_salary: r.base_salary_clp,
      meal_allowance: r.colacion_clp,
      transport_allowance: r.movilizacion_clp,
      bonus: r.gratificacion_clp,
      taxable_total: r.total_imponible_clp,
      non_taxable_total: r.total_no_imponible_clp,
      total: r.total_haberes_clp,
    },
    deductions: {
      pension: r.desc_afp_clp,
      health: r.desc_health_clp,
      income_tax: r.desc_tax_clp,
      unemployment_insurance: r.desc_cesantia_clp,
      voluntary_pension: r.desc_apv_clp,
      other: r.desc_other_clp,
      total: r.total_descuentos_clp,
    },
    net_pay: r.liquido_clp,
    lines: r.lines.map((l) => ({ position: l.position, side: l.side, section: l.section, label: l.label, amount: l.amount })),
    indices: { uf: r.uf_mes, utm: r.utm_mes, pension_cap_uf: r.tope_previsional_uf, unemployment_cap_uf: r.tope_cesantia_uf },
  };
}

export function payslipsPayload(index: { parser_version: string; rows: ParsedPayrollRow[] }, apply: boolean): EmploymentPayslipsPayload {
  return { apply, parser_version: index.parser_version, payslips: index.rows.map(payslipFromParsedRow) };
}
