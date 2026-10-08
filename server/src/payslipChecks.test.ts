import { afterEach, describe, expect, it } from "vitest";
import { employmentPayslipsKind, payrollParametersKind, type Payslip } from "nw-tracker-contracts";
import { db } from "./db.js";
import { igcTax } from "./f22Draft.js";
import { applyPayrollParameters } from "./payrollParametersApply.js";
import { buildPayslipChecks, payrollWithholdingYear } from "./payslipChecks.js";
import { applyEmploymentPayslips } from "./payslipsApply.js";

const DOC = "vitest-payslip-checks/2099-03.pdf";
const MONTH = {
  period_month: "2099-03",
  document: "2099-03.pdf",
  uf: 40_000,
  utm: 70_000,
  pension_cap_uf: 80,
  unemployment_cap_uf: 120,
  afp_worker_rates: { uno: 10.46, modelo: 10.58 },
  afp_employer_rate: 0.1,
  afc_worker_rate: 0.6,
  afc_employer_rate: 2.4,
};

// Taxable pay 3.300.000 (one line taxable by section although its kind is an allowance), capped at
// 80 UF × 40.000 = 3.200.000.
function payslip(tax: number): Payslip {
  const lines: Payslip["lines"] = [
    { position: 0, side: "haber", section: "imponible", label: "Sueldo Base", amount: 3_280_000 },
    { position: 1, side: "haber", section: "imponible", label: "Asignacion Teletrabajo", amount: 20_000 },
    { position: 2, side: "haber", section: "no_imponible", label: "Asig. Colación", amount: 50_000 },
    { position: 3, side: "descuento", section: null, label: "Descuento AFP", amount: 334_720 },
    { position: 4, side: "descuento", section: null, label: "Cotizacion Salud", amount: 224_000 },
    { position: 5, side: "descuento", section: null, label: "Cotizacion Adicional Isapre", amount: 10_000 },
    { position: 6, side: "descuento", section: null, label: "Seguro de Desempleo", amount: 19_800 },
    { position: 7, side: "descuento", section: null, label: "Impuesto Unico", amount: tax },
  ];
  const haberes = 3_350_000;
  const descuentos = 334_720 + 224_000 + 10_000 + 19_800 + tax;
  return {
    document: DOC,
    period_month: "2099-03",
    employer: { name: "VITEST EMPLEADOR SPA", rut: null },
    pay_period_label: null,
    kind: "salary",
    pension_fund: "uno",
    earnings: { base_salary: 3_280_000, meal_allowance: 50_000, transport_allowance: null, bonus: null, taxable_total: 3_200_000, non_taxable_total: 50_000, total: haberes },
    deductions: { pension: 334_720, health: 234_000, income_tax: tax, unemployment_insurance: 19_800, voluntary_pension: null, other: null, total: descuentos },
    net_pay: haberes - descuentos,
    lines,
    indices: { uf: null, utm: null, pension_cap_uf: null, unemployment_cap_uf: null },
  };
}

describe("payslip checks", () => {
  afterEach(() => {
    db.prepare(`DELETE FROM payroll_work_earnings WHERE source_pdf LIKE 'vitest-payslip-checks/%'`).run();
    db.prepare(`DELETE FROM payroll_parameters WHERE period_month = '2099-03'`).run();
  });

  it("recomputes the base, the AFP, health, unemployment and the tax; a payslip that follows the law has no differences", () => {
    expect(applyPayrollParameters(payrollParametersKind.payload.parse({ months: [MONTH] }))).toMatchObject({ added: ["2099-03"], changed: [] });
    // Taxable for tax: 3.300.000 − 334.720 − 224.000 (health capped at 7 % of the base) − 19.800.
    const tax = Math.round(igcTax(3_300_000 - 334_720 - 224_000 - 19_800, 70_000, 2100));
    applyEmploymentPayslips(employmentPayslipsKind.payload.parse({ apply: true, parser_version: "v", payslips: [payslip(tax)] }));
    const row = buildPayslipChecks().find((c) => c.period_month === "2099-03")!;
    expect(row.checks.map((c) => [c.check, c.expected])).toEqual([
      ["taxable_base", 3_200_000],
      ["pension", 334_720],
      ["health_minimum", 224_000],
      ["unemployment", 19_800],
      ["income_tax", tax],
    ]);
    expect(row.differences).toEqual([]);
  });

  it("records a withholding that differs from the table, and sums the year", () => {
    applyPayrollParameters(payrollParametersKind.payload.parse({ months: [MONTH] }));
    const tax = Math.round(igcTax(3_300_000 - 334_720 - 224_000 - 19_800, 70_000, 2100));
    applyEmploymentPayslips(employmentPayslipsKind.payload.parse({ apply: true, parser_version: "v", payslips: [payslip(tax - 500)] }));
    const row = buildPayslipChecks().find((c) => c.period_month === "2099-03")!;
    expect(row.differences).toEqual([{ check: "income_tax", expected: tax, printed: tax - 500, difference: -500 }]);
    expect(payrollWithholdingYear(2099)).toMatchObject({ payslips: 1, difference: -500, months_with_differences: ["2099-03"] });
  });

  it("a payslip newer than the newest published parameters waits; an older month without them is an error", () => {
    applyPayrollParameters(payrollParametersKind.payload.parse({ months: [{ ...MONTH, period_month: "2099-02", document: "2099-02.pdf" }] }));
    applyEmploymentPayslips(employmentPayslipsKind.payload.parse({ apply: true, parser_version: "v", payslips: [payslip(1_000)] }));
    expect(buildPayslipChecks().find((c) => c.period_month === "2099-03")).toMatchObject({ pending: true, checks: [] });
    applyPayrollParameters(payrollParametersKind.payload.parse({ months: [{ ...MONTH, period_month: "2099-04", document: "2099-04.pdf" }] }));
    expect(() => buildPayslipChecks()).toThrow(/no payroll parameters for 2099-03/);
    db.prepare(`DELETE FROM payroll_parameters WHERE period_month IN ('2099-02', '2099-04')`).run();
  });

  it("re-sent parameters report what changed", () => {
    applyPayrollParameters(payrollParametersKind.payload.parse({ months: [MONTH] }));
    const d = applyPayrollParameters(payrollParametersKind.payload.parse({ months: [{ ...MONTH, utm: 70_001, afp_worker_rates: { uno: 10.46, modelo: 10.6 } }] }));
    expect(d.changed).toEqual(["2099-03: utm 70000 → 70001", "2099-03: modelo 10.58 → 10.6"]);
  });
});
