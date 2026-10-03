import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { employmentPayslipsKind } from "nw-tracker-contracts";
import { payslipsPayload, readPayrollParseIndex, type ParsedPayrollRow } from "./payslips.js";

const ROW: ParsedPayrollRow = {
  source_pdf: "liquidaciones/2099/2099-01.pdf",
  period_month: "2099-01",
  employer_name: "VITEST EMPLEADOR SPA",
  employer_rut: null,
  pay_period_label: null,
  base_salary_clp: 1000,
  colacion_clp: 10,
  movilizacion_clp: 20,
  gratificacion_clp: null,
  total_imponible_clp: 1000,
  total_no_imponible_clp: 30,
  total_haberes_clp: 1030,
  desc_afp_clp: 110,
  desc_health_clp: 70,
  desc_tax_clp: 0,
  desc_cesantia_clp: 6,
  desc_apv_clp: 0,
  desc_other_clp: null,
  total_descuentos_clp: 186,
  liquido_clp: 844,
  uf_mes: 40000.5,
  utm_mes: null,
  tope_previsional_uf: 87.8,
  tope_cesantia_uf: null,
  format: "talana_buk",
};

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function index(body: unknown): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "vitest-payroll-"));
  dirs.push(d);
  const file = path.join(d, "all.json");
  fs.writeFileSync(file, JSON.stringify(body));
  return file;
}

describe("payroll parse index → employment.payslips", () => {
  it("maps each parsed payslip onto the contract", () => {
    const payload = employmentPayslipsKind.payload.parse(
      payslipsPayload(readPayrollParseIndex(index({ parser_version: "abc", rows: [ROW], failures: [] })), false)
    );
    expect(payload).toMatchObject({ apply: false, parser_version: "abc" });
    expect(payload.payslips[0]).toMatchObject({
      document: "liquidaciones/2099/2099-01.pdf",
      kind: "salary",
      earnings: { meal_allowance: 10, transport_allowance: 20, bonus: null, non_taxable_total: 30 },
      deductions: { pension: 110, unemployment_insurance: 6, total: 186 },
      net_pay: 844,
      indices: { uf: 40000.5, utm: null, pension_cap_uf: 87.8 },
    });
  });

  it("refuses an index with failures or without payslips", () => {
    expect(() => readPayrollParseIndex(index({ rows: [ROW], failures: ["x.pdf"] }))).toThrow(/1 failure/);
    expect(() => readPayrollParseIndex(index({ rows: [] }))).toThrow(/no parsed payslips/);
    expect(() => readPayrollParseIndex("/nonexistent/all.json")).toThrow(/run npm run parse:payroll-liquidaciones/);
  });
});
