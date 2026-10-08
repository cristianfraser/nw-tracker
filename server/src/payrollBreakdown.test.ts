import { afterEach, describe, expect, it } from "vitest";
import { employmentPayslipsKind, type Payslip } from "nw-tracker-contracts";
import { db } from "./db.js";
import { buildPayrollBreakdown } from "./payrollBreakdown.js";
import { applyEmploymentPayslips } from "./payslipsApply.js";

const DOC = "vitest-payroll-breakdown/2099-01.pdf";

const PAYSLIP: Payslip = {
  document: DOC,
  period_month: "2099-01",
  employer: { name: "VITEST EMPLEADOR SPA", rut: null },
  pay_period_label: null,
  kind: "salary",
  earnings: { base_salary: 1_000_000, meal_allowance: 50_000, transport_allowance: null, bonus: null, taxable_total: 1_000_000, non_taxable_total: 50_000, total: 1_050_000 },
  deductions: { pension: 104_600, health: 80_000, income_tax: 10_000, unemployment_insurance: 6_000, voluntary_pension: null, other: 9_000, total: 209_600 },
  net_pay: 840_400,
  lines: [
    { position: 0, side: "haber", section: "imponible", label: "Sueldo Base", amount: 1_000_000 },
    { position: 1, side: "haber", section: "no_imponible", label: "Colación", amount: 50_000 },
    { position: 2, side: "descuento", section: null, label: "Descuento AFP", amount: 104_600 },
    { position: 3, side: "descuento", section: null, label: "Cotizacion Salud", amount: 70_000 },
    { position: 4, side: "descuento", section: null, label: "Cotizacion Adicional Isapre", amount: 10_000 },
    { position: 5, side: "descuento", section: null, label: "Seguro de Desempleo", amount: 6_000 },
    { position: 6, side: "descuento", section: null, label: "Impuesto Unico", amount: 10_000 },
    { position: 7, side: "descuento", section: null, label: "Seguro Vida Costo Empresa", amount: 9_000 },
  ],
  indices: { uf: null, utm: null, pension_cap_uf: null, unemployment_cap_uf: null },
};

describe("payroll breakdown", () => {
  afterEach(() => {
    db.prepare(`DELETE FROM payroll_work_earnings WHERE source_pdf LIKE 'vitest-payroll-breakdown/%'`).run();
  });

  it("splits gross into net and each deduction, the AFP line into the 10 % and the commission", () => {
    applyEmploymentPayslips(employmentPayslipsKind.payload.parse({ apply: true, parser_version: "vitest", payslips: [PAYSLIP] }));
    const b = buildPayrollBreakdown();
    const month = b.months.find((m) => m.period === "2099-01")!;
    const clp = Object.fromEntries(Object.entries(month.values).map(([k, v]) => [k, v.clp]));
    expect(clp).toMatchObject({
      gross: 1_050_000,
      gross_taxable: 1_000_000,
      gross_non_taxable: 50_000,
      pension: 100_000,
      pension_commission: 4_600,
      health: 80_000,
      unemployment: 6_000,
      income_tax: 10_000,
      insurance: 9_000,
      other_deductions: 9_000,
      deductions: 209_600,
      net: 840_400,
    });
    expect(month.values.net.usd).toBeGreaterThan(0);
    expect(b.years.find((y) => y.period === "2099")!.values.net.clp).toBe(840_400);
  });
});
