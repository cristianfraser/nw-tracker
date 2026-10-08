import { afterEach, describe, expect, it } from "vitest";
import { employmentPayslipsKind, type Payslip } from "nw-tracker-contracts";
import { assignFlowExpenseLineCategory } from "./assignFlowExpenseLineCategory.js";
import { db } from "./db.js";
import { buildFlowsExpensesPayload } from "./flowsExpenses.js";
import { loadPayslipExpenseLineDrafts } from "./payslipExpenseLines.js";
import { applyEmploymentPayslips } from "./payslipsApply.js";

const DOC = "vitest-payslip-expenses/2099-02.pdf";

const PAYSLIP: Payslip = {
  document: DOC,
  period_month: "2099-02",
  employer: { name: "VITEST EMPLEADOR SPA", rut: null },
  pay_period_label: null,
  kind: "salary",
  earnings: { base_salary: 1_000_000, meal_allowance: null, transport_allowance: null, bonus: null, taxable_total: 1_000_000, non_taxable_total: 0, total: 1_000_000 },
  deductions: { pension: 104_600, health: 80_000, income_tax: 10_000, unemployment_insurance: 6_000, voluntary_pension: 50_000, other: 20_000, total: 270_600 },
  net_pay: 729_400,
  lines: [
    { position: 0, side: "haber", section: "imponible", label: "Sueldo Base", amount: 1_000_000 },
    { position: 1, side: "descuento", section: null, label: "Descuento AFP", amount: 104_600 },
    { position: 2, side: "descuento", section: null, label: "Cotizacion Salud", amount: 70_000 },
    { position: 3, side: "descuento", section: null, label: "Cotizacion Adicional Isapre", amount: 10_000 },
    { position: 4, side: "descuento", section: null, label: "Seguro de Desempleo", amount: 6_000 },
    { position: 5, side: "descuento", section: null, label: "Impuesto Unico", amount: 10_000 },
    { position: 6, side: "descuento", section: null, label: "APV 2", amount: 50_000 },
    { position: 7, side: "descuento", section: null, label: "Anticipo Aguinaldo", amount: 20_000 },
  ],
  indices: { uf: null, utm: null, pension_cap_uf: null, unemployment_cap_uf: null },
};

describe("payslip deductions as expense lines", () => {
  afterEach(() => {
    db.prepare(`DELETE FROM payroll_work_earnings WHERE source_pdf LIKE 'vitest-payslip-expenses/%'`).run();
  });

  it("health, the AFP commission and the tax are gastos in the payslip's month; savings and advances are not", () => {
    applyEmploymentPayslips(employmentPayslipsKind.payload.parse({ apply: true, parser_version: "vitest", payslips: [PAYSLIP] }));
    const lines = loadPayslipExpenseLineDrafts().filter((l) => l.expense_month === "2099-02");
    expect(lines.map((l) => [l.category_slug, l.amount_clp, (l.merchant ?? "").split(" · ")[0]])).toEqual([
      ["pension_fees", 4_600, "Comisión AFP"],
      ["healthcare", 70_000, "Cotizacion Salud"],
      ["healthcare", 10_000, "Cotizacion Adicional Isapre"],
      ["taxes", 10_000, "Impuesto Unico"],
    ]);
    expect(lines.every((l) => l.source === "payslip" && l.occurred_on === "2099-02-28" && l.category_unique)).toBe(true);
    const inPayload = buildFlowsExpensesPayload().lines.filter((l) => l.source === "payslip" && l.expense_month === "2099-02");
    expect(inPayload.map((l) => [l.purchase_key.startsWith("payslip:"), l.origin_label])).toEqual(
      Array(4).fill([true, "Liquidación"])
    );
    expect(() =>
      assignFlowExpenseLineCategory({ lineId: inPayload[0]!.statement_line_id, source: "payslip", unique: true, categorySlug: "food" })
    ).toThrow(/fixed category/);
  });
});
