import { afterEach, describe, expect, it } from "vitest";
import { employmentPayslipsKind, type Payslip } from "nw-tracker-contracts";
import { db } from "./db.js";
import { applyEmploymentPayslips } from "./payslipsApply.js";

const DOC = "vitest-payslips/2099-01.pdf";

const LINES: Payslip["lines"] = [
  { position: 0, side: "haber", section: "imponible", label: "Sueldo Base", amount: 1_000_000 },
  { position: 1, side: "haber", section: "no_imponible", label: "Colación", amount: 50_000 },
  { position: 2, side: "haber", section: "no_imponible", label: "Movilización", amount: 40_000 },
  { position: 3, side: "descuento", section: "legal", label: "AFP", amount: 110_000 },
  { position: 4, side: "descuento", section: "legal", label: "Isapre 7%", amount: 70_000 },
  { position: 5, side: "descuento", section: "legal", label: "Impuesto Unico", amount: 10_000 },
  { position: 6, side: "descuento", section: "legal", label: "Seguro de cesantía", amount: 6_000 },
  { position: 7, side: "descuento", section: "other", label: "Cuota sindical", amount: 83 },
];

function lines() {
  return db
    .prepare(
      `SELECT l.position, l.side, l.section, l.label, l.amount FROM payslip_lines l
         JOIN payroll_work_earnings p ON p.id = l.payslip_id WHERE p.source_pdf = ? ORDER BY l.position`
    )
    .all(DOC);
}

function payslip(over: Partial<Payslip> = {}): Payslip {
  return {
    document: DOC,
    period_month: "2099-01",
    employer: { name: "VITEST EMPLEADOR SPA", rut: "11.111.111-1" },
    pay_period_label: "Enero 2099",
    kind: "salary",
    earnings: { base_salary: 1_000_000, meal_allowance: 50_000, transport_allowance: 40_000, bonus: null, taxable_total: 1_000_000, non_taxable_total: 90_000, total: 1_090_000 },
    deductions: { pension: 110_000, health: 70_000, income_tax: 10_000, unemployment_insurance: 6_000, voluntary_pension: 0, other: 83, total: 196_083 },
    // No deposit in the test DB pays this amount on any day.
    net_pay: 893_917,
    lines: LINES,
    indices: { uf: 40_000.12, utm: 70_000, pension_cap_uf: 87.8, unemployment_cap_uf: 131.8 },
    ...over,
  };
}

function apply(p: Payslip, applyIt = true) {
  return applyEmploymentPayslips(employmentPayslipsKind.payload.parse({ apply: applyIt, parser_version: "vitest", payslips: [p] }));
}

function stored() {
  return db.prepare(`SELECT * FROM payroll_work_earnings WHERE source_pdf = ?`).get(DOC) as Record<string, unknown> | undefined;
}

describe("employment.payslips apply", () => {
  afterEach(() => {
    db.prepare(`DELETE FROM payroll_work_earnings WHERE source_pdf LIKE 'vitest-payslips/%'`).run();
  });

  it("stores a payslip under its document, and reports one no deposit pays", () => {
    const d = apply(payslip());
    expect(d).toMatchObject({ applied: true, payslips: 1, linked: 0, links: [], ambiguous: [] });
    expect(d.unmatched).toEqual([{ document: DOC, net_pay: 893_917, period_month: "2099-01" }]);
    expect(stored()).toMatchObject({
      employer_name: "VITEST EMPLEADOR SPA",
      colacion_clp: 50_000,
      movilizacion_clp: 40_000,
      desc_cesantia_clp: 6_000,
      total_descuentos_clp: 196_083,
      liquido: 893_917,
      liquido_currency: "clp",
      uf_mes: 40_000.12,
      tope_cesantia_uf: 131.8,
      parse_version: "vitest",
      movement_id: null,
      link_source: null,
    });
    expect(lines()).toEqual(LINES);
  });

  it("a dry run lists what would change and writes nothing", () => {
    expect(apply(payslip(), false).changes).toEqual([`new ${DOC}`]);
    expect(stored()).toBeUndefined();
    apply(payslip());
    const changed = LINES.map((l) => (l.position === 7 ? { ...l, amount: 82 } : l));
    const d = apply(payslip({ net_pay: 893_918, deductions: { ...payslip().deductions, other: 82, total: 196_082 }, lines: changed }), false);
    expect(d.changes).toEqual([
      `change ${DOC}: desc_other_clp 83 → 82; total_descuentos_clp 196083 → 196082; liquido 893917 → 893918`,
      `lines ${DOC}: differ → 8 line(s)`,
    ]);
    expect(stored()).toMatchObject({ liquido: 893_917, desc_other_clp: 83 });
    expect(lines()).toEqual(LINES);
  });

  it("a re-import replaces the stored lines", () => {
    apply(payslip());
    const relabelled = LINES.map((l) => (l.position === 7 ? { ...l, label: "Aporte sindical" } : l));
    apply(payslip({ lines: relabelled }));
    expect(lines()).toEqual(relabelled);
  });

  it("a re-import updates the printed fields and keeps a hand-made pairing and its earning type", () => {
    apply(payslip());
    const movementId = (db.prepare(`SELECT id FROM movements ORDER BY id LIMIT 1`).get() as { id: number }).id;
    db.prepare(`UPDATE payroll_work_earnings SET movement_id = ?, link_source = 'manual', earning_type = 'severance' WHERE source_pdf = ?`).run(movementId, DOC);
    const d = apply(payslip({ pay_period_label: "Enero de 2099" }));
    expect(d).toMatchObject({ linked: 1, unmatched: [] });
    expect(stored()).toMatchObject({ pay_period_label: "Enero de 2099", movement_id: movementId, link_source: "manual", earning_type: "severance" });
  });

  it("the payload refuses a document sent twice", () => {
    expect(() =>
      employmentPayslipsKind.payload.parse({ apply: true, parser_version: "v", payslips: [payslip(), payslip()] })
    ).toThrow(/appears twice/);
  });
});
