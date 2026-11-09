/**
 * A US W-2 pay stub through `employment.payslips` v4: stored with its jurisdiction, lines and
 * kinds, checked against the federal law, broken down and turned into gastos lines — and left out
 * of every Chilean reader.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { employmentPayslipsKind, type UsPayslip } from "nw-tracker-contracts";
import { db } from "./db.js";
import { loadPayrollWorkEarnings } from "./flowsPayrollWorkEarnings.js";
import { buildPayrollBreakdown } from "./payrollBreakdown.js";
import { payrollTaxYear } from "./payrollTaxYear.js";
import { buildPayslipChecks, payrollWithholdingYear } from "./payslipChecks.js";
import { loadPayslipExpenseLineDrafts } from "./payslipExpenseLines.js";
import { applyEmploymentPayslips, latestPayslip, latestSalaryPayslipPeriod } from "./payslipsApply.js";
import { overrideFxDaily } from "./test/fxDailyFixture.js";

const PREFIX = "vitest-us-payslips/";
const RATE = 950;

/** Biweekly $4.000, single, 2026: 6 % pre-tax 401(k), medical, dental, HSA; the employer matches 4 %. */
function stub(payDate: string, over: { federal?: number; socialSecurity?: number } = {}): UsPayslip {
  const federal = over.federal ?? 446.88;
  const ss = over.socialSecurity ?? 236.53;
  const deductions = [federal, ss, 55.32, 240, 120, 15, 50];
  const total = Math.round(deductions.reduce((s, x) => s + x * 100, 0)) / 100;
  return {
    jurisdiction: "us",
    pay_period: "biweekly",
    document: `${PREFIX}${payDate}.pdf`,
    period_month: payDate.slice(0, 7),
    pay_date: payDate,
    period_start: "2026-02-15",
    period_end: "2026-02-28",
    employer: { name: "EXAMPLECO INC", ein: "12-3456789" },
    kind: "salary",
    w4: { filing_status: "single" },
    gross_pay: 4_000,
    total_deductions: total,
    net_pay: Math.round((4_000 - total) * 100) / 100,
    lines: [
      { position: 0, side: "haber", label: "Regular Pay", amount: 4_000 },
      { position: 1, side: "descuento", label: "Federal Income Tax", amount: federal },
      { position: 2, side: "descuento", label: "Social Security", amount: ss },
      { position: 3, side: "descuento", label: "Medicare", amount: 55.32 },
      { position: 4, side: "descuento", label: "401(k)", amount: 240 },
      { position: 5, side: "descuento", label: "Medical", amount: 120 },
      { position: 6, side: "descuento", label: "Dental", amount: 15 },
      { position: 7, side: "descuento", label: "HSA", amount: 50 },
      { position: 8, side: "memo", label: "401(k) Employer Match", amount: 160 },
    ],
  };
}

function apply(payslips: UsPayslip[]) {
  return applyEmploymentPayslips(employmentPayslipsKind.payload.parse({ parser_version: "vitest", payslips }));
}

function storedId(doc: string): number {
  return (db.prepare(`SELECT id FROM payroll_work_earnings WHERE source_pdf = ?`).get(doc) as { id: number }).id;
}

describe("US payslips", () => {
  let restoreFx: () => void = () => {};
  beforeEach(() => {
    restoreFx = overrideFxDaily([
      ["2026-03-06", RATE],
      ["2026-03-20", RATE],
      ["2026-12-04", RATE],
      ["2026-12-18", RATE],
    ]);
  });
  afterEach(() => {
    db.prepare(`DELETE FROM payroll_work_earnings WHERE source_pdf LIKE '${PREFIX}%'`).run();
    restoreFx();
  });

  it("the contract checks a stub's sums and its month", () => {
    const bad = { ...stub("2026-03-06"), net_pay: 2_000 };
    expect(() => employmentPayslipsKind.payload.parse({ parser_version: "v", payslips: [bad] })).toThrow(/net pay 2000/);
    const wrongMonth = { ...stub("2026-03-06"), period_month: "2026-02" };
    expect(() => employmentPayslipsKind.payload.parse({ parser_version: "v", payslips: [wrongMonth] })).toThrow(/pay date's month/);
    const fraction = stub("2026-03-06");
    fraction.lines[0] = { ...fraction.lines[0]!, amount: 4_000.001 };
    expect(() => employmentPayslipsKind.payload.parse({ parser_version: "v", payslips: [fraction] })).toThrow(/cents/);
    const noJurisdiction: Record<string, unknown> = { ...stub("2026-03-06") };
    delete noJurisdiction.jurisdiction;
    expect(() => employmentPayslipsKind.payload.parse({ parser_version: "v", payslips: [noJurisdiction] })).toThrow();
  });

  it("stores two stubs of one month with their jurisdiction, lines and kinds", () => {
    const d = apply([stub("2026-03-06"), stub("2026-03-20")]);
    expect(d).toMatchObject({ payslips: 2, linked: 0, ambiguous: [] });
    expect(d.unmatched.map((u) => u.document)).toEqual([`${PREFIX}2026-03-06.pdf`, `${PREFIX}2026-03-20.pdf`]);
    const row = db.prepare(`SELECT * FROM payroll_work_earnings WHERE source_pdf = ?`).get(`${PREFIX}2026-03-06.pdf`);
    expect(row).toMatchObject({
      jurisdiction: "us",
      pay_period: "biweekly",
      pay_date: "2026-03-06",
      w4_filing_status: "single",
      period_month: "2026-03",
      employer_rut: "12-3456789",
      pay_period_label: "2026-02-15 – 2026-02-28",
      liquido: 2_836.27,
      liquido_currency: "usd",
      total_haberes_clp: null,
      desc_tax_clp: null,
    });
    const lines = db
      .prepare(`SELECT side, kind, amount FROM payslip_lines WHERE payslip_id = ? ORDER BY position`)
      .all(storedId(`${PREFIX}2026-03-06.pdf`));
    expect(lines).toEqual([
      { side: "haber", kind: "wages", amount: 4_000 },
      { side: "descuento", kind: "federal_income_tax", amount: 446.88 },
      { side: "descuento", kind: "social_security_tax", amount: 236.53 },
      { side: "descuento", kind: "medicare_tax", amount: 55.32 },
      { side: "descuento", kind: "retirement_401k_pretax", amount: 240 },
      { side: "descuento", kind: "health_premium", amount: 120 },
      { side: "descuento", kind: "dental_vision", amount: 15 },
      { side: "descuento", kind: "hsa", amount: 50 },
      { side: "memo", kind: "employer_401k_match", amount: 160 },
    ]);
  });

  it("a Chilean label on a US stub fails the import before anything is written", () => {
    const s = stub("2026-03-06");
    s.lines[1] = { ...s.lines[1]!, label: "Impuesto Unico" };
    expect(() => apply([s])).toThrow(/no us kind for the descuento «Impuesto Unico»/);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM payroll_work_earnings WHERE source_pdf LIKE '${PREFIX}%'`).get()).toEqual({ n: 0 });
  });

  it("checks FICA to the cent and the withholding by the percentage method", () => {
    apply([stub("2026-03-06"), stub("2026-03-20", { federal: 447, socialSecurity: 236 })]);
    const rows = buildPayslipChecks().filter((c) => c.jurisdiction === "us" && [`${PREFIX}2026-03-06.pdf`, `${PREFIX}2026-03-20.pdf`].map(storedId).includes(c.payslip_id));
    expect(rows).toHaveLength(2);
    const [first, second] = rows as [(typeof rows)[number], (typeof rows)[number]];
    expect(first).toMatchObject({ currency: "usd", pending: false, differences: [] });
    expect(first.checks).toEqual([
      { check: "social_security_tax", expected: 236.53, printed: 236.53, difference: 0 },
      { check: "medicare_tax", expected: 55.32, printed: 55.32, difference: 0 },
      { check: "federal_withholding", expected: 446.88, printed: 446.88, difference: 0 },
      { check: "deferral_limit", expected: 240, printed: 240, difference: 0 },
    ]);
    // The withholding rounded to the dollar is allowed; Social Security 53 cents short is not.
    expect(second.differences).toEqual([{ check: "social_security_tax", expected: 236.53, printed: 236, difference: -0.53 }]);
  });

  it("breaks a stub down by its own groups, the match apart, at the pay date's rate", () => {
    apply([stub("2026-03-06")]);
    const p = buildPayrollBreakdown().payslips.find((x) => x.payslip_id === storedId(`${PREFIX}2026-03-06.pdf`))!;
    expect(p.jurisdiction).toBe("us");
    const usd = Object.fromEntries(Object.entries(p.values).map(([k, v]) => [k, Math.round(v.usd * 100) / 100]));
    expect(usd).toMatchObject({
      gross: 4_000,
      gross_taxable: 4_000,
      income_tax: 446.88,
      social_security_medicare: 291.85,
      retirement_401k: 240,
      health: 135,
      hsa: 50,
      deductions: 1_163.73,
      net: 2_836.27,
      employer_retirement: 160,
      pension: 0,
    });
    expect(p.values.net.clp).toBeCloseTo(2_836.27 * RATE, 6);
  });

  it("turns taxes and premiums into gastos lines, never the 401(k) or the HSA", () => {
    apply([stub("2026-03-06")]);
    const id = storedId(`${PREFIX}2026-03-06.pdf`);
    const lines = loadPayslipExpenseLineDrafts().filter((l) => Math.floor(l.statement_line_id / 1000) === id);
    expect(lines.map((l) => [l.category_slug, l.amount_usd, l.amount_clp])).toEqual([
      ["taxes", 446.88, Math.round(446.88 * RATE)],
      ["taxes", 236.53, Math.round(236.53 * RATE)],
      ["taxes", 55.32, Math.round(55.32 * RATE)],
      ["healthcare", 120, 120 * RATE],
      ["healthcare", 15, 15 * RATE],
    ]);
    expect(lines.every((l) => l.occurred_on === "2026-03-06" && l.pre_tax)).toBe(true);
  });

  it("the income table shows it in dollars and pesos", () => {
    apply([stub("2026-03-06")]);
    const row = loadPayrollWorkEarnings().find((r) => r.id === storedId(`${PREFIX}2026-03-06.pdf`))!;
    expect(row).toMatchObject({ jurisdiction: "us", pay_date: "2026-03-06", liquido_usd: 2_836.27, liquido_clp: Math.round(2_836.27 * RATE) });
  });

  it("the Chilean readers leave it out", () => {
    const before = {
      tax: payrollTaxYear(2026),
      withholding: payrollWithholdingYear(2026),
      latest: latestPayslip(),
      latestSalary: latestSalaryPayslipPeriod(),
    };
    // In December, after every Chilean payslip of the test person.
    apply([stub("2026-12-04"), stub("2026-12-18")]);
    expect({
      tax: payrollTaxYear(2026),
      withholding: payrollWithholdingYear(2026),
      latest: latestPayslip(),
      latestSalary: latestSalaryPayslipPeriod(),
    }).toEqual(before);
  });

  it("a document cannot change jurisdiction", () => {
    apply([stub("2026-03-06")]);
    db.prepare(`UPDATE payroll_work_earnings SET jurisdiction = 'cl' WHERE source_pdf = ?`).run(`${PREFIX}2026-03-06.pdf`);
    expect(() => apply([stub("2026-03-06")])).toThrow(/stored as a cl payslip, sent as us/);
  });
});
