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
  lines: [
    { position: 0, side: "haber", section: "imponible", label: "Sueldo Ganado", amount: 1000 },
    { position: 1, side: "haber", section: "no_imponible", label: "Asig. Colación", amount: 10 },
    { position: 2, side: "haber", section: "no_imponible", label: "Asig. Movilización", amount: 20 },
    { position: 3, side: "descuento", section: null, label: "Descuento AFP", amount: 110 },
    { position: 4, side: "descuento", section: null, label: "Cotizacion Salud", amount: 70 },
    { position: 5, side: "descuento", section: null, label: "Seguro de Desempleo", amount: 6 },
  ],
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
    expect(payload.payslips[0]!.lines).toHaveLength(6);
  });

  it("the contract refuses lines that do not add up to the payslip's totals", () => {
    const parse = (row: ParsedPayrollRow) =>
      employmentPayslipsKind.payload.safeParse(payslipsPayload({ parser_version: "abc", rows: [row] }, false));
    expect(parse(ROW).success).toBe(true);
    const short = { ...ROW, lines: ROW.lines!.slice(0, -1) };
    expect(JSON.stringify(parse(short).error?.issues)).toMatch(/descuentos lines add up to 180, total 186/);
    const noTotals = { ...short, total_descuentos_clp: null };
    expect(JSON.stringify(parse(noTotals).error?.issues)).toMatch(/haberes − descuentos = 850, net pay 844/);
  });

  it("refuses a parse without lines", () => {
    expect(() => payslipsPayload({ parser_version: "abc", rows: [{ ...ROW, lines: [] }] }, false)).toThrow(/no lines/);
  });

  it("refuses an index with failures or without payslips", () => {
    expect(() => readPayrollParseIndex(index({ rows: [ROW], failures: ["x.pdf"] }))).toThrow(/1 failure/);
    expect(() => readPayrollParseIndex(index({ rows: [] }))).toThrow(/no parsed payslips/);
    expect(() => readPayrollParseIndex("/nonexistent/all.json")).toThrow(/run npm run parse:payroll-liquidaciones/);
  });
});
