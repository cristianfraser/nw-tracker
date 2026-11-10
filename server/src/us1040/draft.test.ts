/**
 * The local Form 1040 (v1): the W-2 boxes from the stored stub lines (one rule with the demo
 * generator's), the form's arithmetic, the Tax Table, the draft on synthetic stubs, the law's
 * years, a filed return against the draft and its settlement, and the route.
 */
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { employmentPayslipsKind, type UsPayslip } from "nw-tracker-contracts";
import { db } from "../db.js";
import { availableUsTaxYears, buildF1040Draft } from "./draft.js";
import { f1040Settlement, filedF1040, linkF1040Settlement, recordFiledF1040 } from "./filed.js";
import { assertF1040Identities, computeF1040Lines, f1040PrintedLine, f1040RoleOfPrintedLine, type F1040Inputs, type F1040Lines } from "./identities.js";
import { buildF1040Payload } from "./payload.js";
import { applyEmploymentPayslips } from "../payslipsApply.js";
import { registerTaxReturnRoutes } from "../routes/taxReturn.js";
import { usBracketTax, usForm1040Tax, usTaxYear } from "../usLegalParameters.js";
import { declareTaxResidency } from "../taxResidency.js";
import { DEMO_US_BANK_ISSUER } from "../taxFacts/payers.js";
import { usBankInterestForYear } from "../usBankAccounts.js";
import { usW2sFromStubLines, type UsW2Stub } from "../usW2.js";
import { usPayDates, usPayStub, usW2StubOf, usW2sOfStubs, newUsPayrollYtd, type UsPayStub } from "../demoData/usPayroll.js";
import type { UsW2Job } from "../demoData/person.js";

const PREFIX = "vitest-f1040/";

/** Every input at zero (the ordinary tax on nothing): a test sets what it reads. */
const ZERO_INPUTS: F1040Inputs = {
  wages1a: 0,
  taxExemptInterest2a: 0,
  interest2b: 0,
  qualifiedDividends3a: 0,
  ordinaryDividends3b: 0,
  capitalGain7: 0,
  additionalIncome8: 0,
  adjustments10: 0,
  deduction12: 0,
  qbiDeduction13: 0,
  additionalDeductions13b: 0,
  taxOn: () => 0,
  schedule2Part1_17: 0,
  childTaxCredit19: 0,
  schedule3Nonrefundable20: 0,
  otherTaxes23: 0,
  withholdingW2_25a: 0,
  withholding1099_25b: 0,
  withholdingOther25c: 0,
  schedule3Credits31: 0,
};
const TODAY = "2026-06-15";

/** A synthetic W-2 job (test employer; the 89 EIN prefix is never issued). */
const JOB: UsW2Job = {
  kind: "us_w2",
  id: "vitest-f1040",
  employer: "VITEST WIDGETS INC",
  ein: "89-0000001",
  bankName: "VITEST WIDGETS PAYROLL",
  from: "2024-04",
  to: null,
  firstPayDate: "2024-04-19",
  annualSalaryUsd: 150_000,
  yearlyRaise: 0.04,
  raiseMonth: 4,
  bonus: { month: 3, fraction: 0.08 },
  payFrequency: "biweekly",
  retirement401kRate: 0.06,
  employerMatchRate: 0.04,
  medicalUsd: 112,
  dentalVisionUsd: 14,
  hsaUsd: 60,
  w4FilingStatus: "single",
};

function generatedStubs(through: string): UsPayStub[] {
  const ytd = newUsPayrollYtd();
  return usPayDates(JOB, through).map((d) => usPayStub(JOB, d, ytd));
}

const KIND_BY_LABEL: Record<string, UsW2Stub["lines"][number]["kind"]> = {
  "Regular Pay": "wages",
  Bonus: "supplemental_bonus",
  "Federal Income Tax": "federal_income_tax",
  "Social Security": "social_security_tax",
  Medicare: "medicare_tax",
  "401(k)": "retirement_401k_pretax",
  Medical: "health_premium",
  Dental: "dental_vision",
  HSA: "hsa",
  "401(k) Employer Match": "employer_401k_match",
};

function asW2Stub(s: UsPayStub): UsW2Stub {
  return {
    ref: s.payDate,
    payDate: s.payDate,
    employer: s.job.employer,
    ein: s.job.ein,
    lines: s.lines.map((l) => ({ side: l.side, kind: KIND_BY_LABEL[l.label]!, amount: l.amount })),
  };
}

function asPayload(s: UsPayStub): UsPayslip {
  return {
    jurisdiction: "us",
    pay_period: "biweekly",
    document: `${PREFIX}${s.payDate}.pdf`,
    period_month: s.payDate.slice(0, 7),
    pay_date: s.payDate,
    period_start: s.periodStart,
    period_end: s.periodEnd,
    employer: { name: s.job.employer, ein: s.job.ein },
    kind: "salary",
    w4: { filing_status: "single" },
    gross_pay: s.gross,
    total_deductions: s.deductions,
    net_pay: s.net,
    lines: s.lines.map((l, i) => ({ position: i, side: l.side, label: l.label, amount: l.amount })),
  };
}

function applyStubs(stubs: UsPayStub[]) {
  applyEmploymentPayslips(employmentPayslipsKind.payload.parse({ parser_version: "vitest", payslips: stubs.map(asPayload) }));
}

const createdAccounts: number[] = [];

function cleanup() {
  db.prepare(`DELETE FROM us_f1040_returns`).run();
  db.prepare(`DELETE FROM payroll_work_earnings WHERE source_pdf LIKE '${PREFIX}%'`).run();
  for (const id of createdAccounts.splice(0)) {
    db.prepare(`DELETE FROM movements WHERE account_id = ?`).run(id);
    db.prepare(`DELETE FROM bank_account_numbers WHERE account_id = ?`).run(id);
    db.prepare(`DELETE FROM accounts WHERE id = ?`).run(id);
  }
}

/** A dollar account declared at the US bank (an issuer `US_BANK_ISSUERS` lists), with its interest rows. */
function usBankSavingsAccount(interest: { day: string; usd: number }[]): number {
  const group = db.prepare(`SELECT id FROM asset_groups ORDER BY id LIMIT 1`).get() as { id: number };
  const n = createdAccounts.length + 1;
  const id = Number(
    db.prepare(`INSERT INTO accounts (asset_group_id, name, import_key) VALUES (?, ?, ?)`).run(group.id, `Vitest · US savings ${n}`, `${PREFIX}savings-${n}`).lastInsertRowid
  );
  createdAccounts.push(id);
  db.prepare(`INSERT INTO bank_account_numbers (account_id, issuer, number, currency) VALUES (?, ?, ?, 'usd')`).run(id, DEMO_US_BANK_ISSUER, `990000000${n}`);
  for (const i of interest) {
    db.prepare(`INSERT INTO movements (account_id, occurred_on, amount, currency, flow_kind, note) VALUES (?, ?, ?, 'usd', 'savings_earnings', 'vitest interest')`).run(id, i.day, i.usd);
  }
  return id;
}

describe("W-2 boxes from the stub lines", () => {
  it("read the generator's stubs with the kinds the import gives their labels", () => {
    const stubs = generatedStubs("2026-12-31");
    expect(stubs.map(usW2StubOf)).toEqual(stubs.map(asW2Stub).map((w) => ({ ...w, ref: expect.any(String) })));
    const w2s = usW2sOfStubs(stubs);
    expect(w2s.map((w) => w.year)).toEqual([2024, 2025, 2026]);
    expect(w2s).toEqual(usW2sFromStubLines(stubs.map(asW2Stub)));
  });

  it("keep a Roth deferral and an RSU vest in box 1, cap box 3 at the wage base, leave the match out", () => {
    const base = usTaxYear(2025).socialSecurityWageBase;
    const stub = (payDate: string, rsu: number): UsW2Stub => ({
      ref: payDate,
      payDate,
      employer: "E",
      ein: "89-1",
      lines: [
        { side: "haber", kind: "wages", amount: 100_000 },
        { side: "haber", kind: "rsu", amount: rsu },
        { side: "descuento", kind: "retirement_401k_pretax", amount: 1_000 },
        { side: "descuento", kind: "retirement_401k_roth", amount: 500 },
        { side: "descuento", kind: "health_premium", amount: 200 },
        { side: "descuento", kind: "hsa", amount: 100 },
        { side: "descuento", kind: "rsu_offset", amount: rsu },
        { side: "descuento", kind: "federal_income_tax", amount: 20_000 },
        { side: "memo", kind: "employer_401k_match", amount: 4_000 },
      ],
    });
    const [w] = usW2sFromStubLines([stub("2025-03-01", 10_000), stub("2025-09-01", 0)]);
    expect(w).toMatchObject({
      stubs: 2,
      wages: 2 * 100_000 + 10_000 - 2 * (1_000 + 200 + 100),
      federalWithheld: 40_000,
      socialSecurityWages: base,
      medicareWages: 2 * 100_000 + 10_000 - 2 * 300,
      box12D: 2_000,
      box12AA: 1_000,
      box12W: 200,
    });
  });

  it("refuse a line that is not a US W-2 kind", () => {
    const s: UsW2Stub = { ref: "x", payDate: "2025-01-10", employer: "E", ein: "89-1", lines: [{ side: "haber", kind: "base_salary", amount: 1 }] };
    expect(() => usW2sFromStubLines([s])).toThrow(/base_salary is not a US W-2 earning/);
  });
});

describe("Form 1040 arithmetic and tax", () => {
  it("computes the chain and checks a return against it", () => {
    const inputs = {
      ...ZERO_INPUTS,
      wages1a: 120_000,
      deduction12: 15_750,
      taxOn: (t: number) => usForm1040Tax(t, "single", 2025),
      withholdingW2_25a: 20_000,
    };
    const lines = computeF1040Lines(inputs);
    expect(lines["15"]).toBe(104_250);
    expect(lines["16"]).toBe(Math.round(usBracketTax(104_250, usTaxYear(2025).brackets.single)));
    expect(lines["24"]).toBe(lines["16"]);
    expect(lines["34"]).toBe(Math.max(0, 20_000 - lines["24"]));
    expect(lines["35a"]).toBe(lines["34"]);
    expect(lines["37"]).toBe(Math.max(0, lines["24"] - 20_000));
    expect(() => assertF1040Identities(lines, "ok")).not.toThrow();
    expect(() => assertF1040Identities({ ...lines, "15": lines["15"] + 1 }, "bad")).toThrow(/line 15 is/);
    expect(() => assertF1040Identities({ ...lines, "99": 1 } as F1040Lines, "bad")).toThrow(/unknown line 99/);
    // Taxable interest (2b) joins the wages in total income (9) and flows down the chain.
    const withInterest = computeF1040Lines({ ...inputs, interest2b: 1_000 });
    expect(withInterest).toMatchObject({ "1z": 120_000, "2b": 1_000, "9": 121_000, "11": 121_000, "15": 105_250 });
    expect(withInterest["16"]).toBe(usForm1040Tax(105_250, "single", 2025));
    expect(() => assertF1040Identities(withInterest, "interest")).not.toThrow();
    expect(() => assertF1040Identities({ ...withInterest, "9": 120_000 }, "bad")).toThrow(/line 9 is/);
    // The 2025 form's Schedule 1-A deductions (13b) join line 14; the 2024 form has no such line.
    const with13b = { ...lines, "13b": 1_000, "14": lines["14"] + 1_000, "15": lines["15"] - 1_000 } as F1040Lines;
    expect(() => assertF1040Identities(with13b, "13b", 2025)).not.toThrow();
    expect(() => assertF1040Identities({ ...lines, "13b": 1_000 } as F1040Lines, "13b", 2025)).toThrow(/line 14 is/);
    expect(() => assertF1040Identities({ ...lines, "13b": 0 } as F1040Lines, "13b", 2024)).not.toThrow();
    expect(() => assertF1040Identities(with13b, "13b", 2024)).toThrow(/2024 form has no line 13b/);
  });

  it("prints each role under the year's own line number: the 2025 form renumbered 11 → 11a, 12 → 12e, 13 → 13a and added 13b", () => {
    expect(f1040PrintedLine("11", 2024)).toBe("11");
    expect(f1040PrintedLine("12", 2024)).toBe("12");
    expect(f1040PrintedLine("11", 2025)).toBe("11a");
    expect(f1040PrintedLine("12", 2025)).toBe("12e");
    expect(f1040PrintedLine("13", 2025)).toBe("13a");
    expect(f1040PrintedLine("13b", 2026)).toBe("13b");
    expect(f1040PrintedLine("24", 2025)).toBe("24");
    expect(() => f1040PrintedLine("13b", 2024)).toThrow(/no line 13b/);
    expect(f1040RoleOfPrintedLine("11a", 2025)).toBe("11");
    expect(f1040RoleOfPrintedLine("11b", 2025)).toBe("11");
    expect(f1040RoleOfPrintedLine("12e", 2025)).toBe("12");
    expect(f1040RoleOfPrintedLine("13a", 2025)).toBe("13");
    expect(f1040RoleOfPrintedLine("13b", 2025)).toBe("13b");
    expect(f1040RoleOfPrintedLine("35a", 2025)).toBe("35a");
    expect(() => f1040RoleOfPrintedLine("12", 2025)).toThrow(/prints no line 12/);
    expect(f1040RoleOfPrintedLine("12", 2024)).toBe("12");
    expect(() => f1040RoleOfPrintedLine("12e", 2024)).toThrow(/prints no line 12e/);
    expect(() => f1040RoleOfPrintedLine("99", 2025)).toThrow(/unknown line 99/);
  });

  it("takes the Tax Table's row midpoint below $100.000 and the exact amount above", () => {
    const single2024 = usTaxYear(2024).brackets.single;
    expect(usForm1040Tax(85_010, "single", 2024)).toBe(Math.round(usBracketTax(85_025, single2024)));
    expect(usForm1040Tax(85_049, "single", 2024)).toBe(Math.round(usBracketTax(85_025, single2024)));
    expect(usForm1040Tax(2_990, "single", 2024)).toBe(Math.round(usBracketTax(2_987.5, single2024)));
    expect(usForm1040Tax(4, "single", 2024)).toBe(0);
    expect(usForm1040Tax(120_001, "single", 2024)).toBe(Math.round(usBracketTax(120_001, single2024)));
  });
});

describe("the 1040 draft", () => {
  afterEach(cleanup);

  it("drafts a closed year from the stored stubs", () => {
    const stubs = generatedStubs("2025-12-31");
    applyStubs(stubs);
    const d = buildF1040Draft(2025, TODAY);
    const w2 = usW2sOfStubs(stubs).find((w) => w.year === 2025)!;
    const deduction = usTaxYear(2025).standardDeduction.single;
    const taxable = Math.round(w2.wages) - deduction;
    expect(d).toMatchObject({ taxYear: 2025, provisional: false, lawYear: 2025, filingStatus: "single", stubs: 26, filed: null });
    expect(d.notes).toEqual(["no_state_return", "residency_undeclared"]);
    expect(d.lines).toMatchObject({
      "1a": Math.round(w2.wages),
      "11": Math.round(w2.wages),
      "12": deduction,
      "15": taxable,
      "16": usForm1040Tax(taxable, "single", 2025),
      "23": 0,
      "25a": Math.round(w2.federalWithheld),
      "25c": 0,
    });
    expect(d.fica).toEqual({ socialSecurity: w2.socialSecurityTax, medicare: w2.medicareTax });
    expect(d.interest).toEqual([]);
    expect(d.lines["2b"]).toBe(0);
    const refund = Math.round(w2.federalWithheld) - (d.lines["24"] ?? 0);
    expect(refund > 0 ? d.lines["35a"] : d.lines["37"]).toBe(Math.abs(refund));
    // No residency declared: every year is drafted as before (a full-year resident, W-2s and US bank interest).
    expect(buildF1040Draft(2024, TODAY).notes).toEqual(["no_state_return", "residency_undeclared"]);
    expect(availableUsTaxYears(TODAY)).toEqual([2026, 2025, 2024]);
  });

  it("reads a US bank account's interest into line 2b (the year's savings_earnings on a dollar account declared at a US bank)", () => {
    applyStubs(generatedStubs("2025-12-31"));
    const savings = usBankSavingsAccount([
      { day: "2025-03-31", usd: 40.4 },
      { day: "2025-12-31", usd: 60.2 },
      { day: "2026-01-31", usd: 55 },
    ]);
    // Interest at a broker, or on an account declared at a Chilean bank, is not a US bank account's.
    const other = usBankSavingsAccount([]);
    db.prepare(`UPDATE bank_account_numbers SET issuer = 'santander' WHERE account_id = ?`).run(other);
    db.prepare(`INSERT INTO movements (account_id, occurred_on, amount, currency, flow_kind, note) VALUES (?, '2025-06-30', 99, 'usd', 'savings_earnings', 'x')`).run(other);
    const interest = usBankInterestForYear(2025);
    expect(interest.usd).toBe(100.6);
    expect(interest.lines.map((l) => [l.accountId, l.date, l.usd])).toEqual([
      [savings, "2025-03-31", 40.4],
      [savings, "2025-12-31", 60.2],
    ]);
    const d = buildF1040Draft(2025, TODAY);
    const plain = buildF1040Draft(2024, TODAY);
    expect(d.interest.reduce((s, i) => s + i.usd, 0)).toBeCloseTo(100.6, 6);
    expect(d.lines["2b"]).toBe(101);
    expect(d.lines["9"]).toBe(d.lines["1a"]! + 101);
    expect(() => assertF1040Identities(d.lines, "2025")).not.toThrow();
    expect(plain.lines["2b"]).toBe(0);
  });

  it("throws for a closed year the law table does not list; an open one takes the latest year's law", () => {
    expect(() => buildF1040Draft(2023, TODAY)).toThrow(/no figures for 2023/);
    applyStubs(generatedStubs("2025-12-31"));
    const open = buildF1040Draft(2027, "2027-02-01");
    expect(open).toMatchObject({ provisional: true, lawYear: 2026, stubs: 0, filingStatus: "single" });
    expect(open.notes).toEqual(["no_state_return", "residency_undeclared", "open_year", "law_provisional"]);
    expect(() => buildF1040Draft(2027, TODAY)).toThrow(/not started/);
  });

  it("compares a filed return with the draft and links its settlement", () => {
    applyStubs(generatedStubs("2025-12-31"));
    const d = buildF1040Draft(2025, TODAY);
    // Filed with $200 less tax than the draft computes (the draft owes a little: the bonus is withheld at 22 %).
    const filedLines = computeF1040Lines({
      ...ZERO_INPUTS,
      wages1a: d.lines["1a"]!,
      deduction12: d.lines["12"]!,
      taxOn: (t) => usForm1040Tax(t, "single", 2025) - 200,
      withholdingW2_25a: d.lines["25a"]!,
    });
    recordFiledF1040({ taxYear: 2025, filingStatus: "single", filedOn: "2026-04-10", sourceFile: "vitest/1040-2025.pdf", lines: filedLines });
    // The same return again is a no-op; another one throws.
    recordFiledF1040({ taxYear: 2025, filingStatus: "single", filedOn: "2026-04-10", sourceFile: "vitest/1040-2025.pdf", lines: filedLines });
    expect(() =>
      recordFiledF1040({ taxYear: 2025, filingStatus: "single", filedOn: "2026-04-11", sourceFile: "vitest/1040-2025.pdf", lines: filedLines })
    ).toThrow(/different return is already stored/);
    expect(() =>
      recordFiledF1040({ taxYear: 2024, filingStatus: "single", filedOn: "2025-04-11", sourceFile: "x", lines: { ...filedLines, "24": 1 } })
    ).toThrow(/line 24 is 1/);
    expect(filedF1040(2025)?.lines["16"]).toBe(d.lines["16"]! - 200);

    const p = buildF1040Payload(2025, TODAY);
    const row = (line: string) => p.rows.find((r) => r.line === line)!;
    expect(row("16")).toMatchObject({ filed: d.lines["16"]! - 200, draft: d.lines["16"], changed: true });
    expect(row("1a")).toMatchObject({ changed: false });
    // Rows carry the role and the 2025 form's own number.
    expect(row("12")).toMatchObject({ printed_line: "12e" });
    expect(row("11")).toMatchObject({ printed_line: "11a" });
    expect(row("24")).toMatchObject({ printed_line: "24" });
    expect(buildF1040Payload(2024, TODAY).rows.find((r) => r.line === "12")).toMatchObject({ printed_line: "12" });
    expect(p.tax_filed).toBe(p.tax_draft - 200);

    const refund = filedLines["35a"];
    expect(refund).toBeGreaterThan(0);
    const group = db.prepare(`SELECT id FROM asset_groups ORDER BY id LIMIT 1`).get() as { id: number };
    const accountId = Number(
      db.prepare(`INSERT INTO accounts (asset_group_id, name, import_key) VALUES (?, ?, ?)`).run(group.id, "Vitest · US checking", `${PREFIX}checking`).lastInsertRowid
    );
    createdAccounts.push(accountId);
    const credit = Number(
      db
        .prepare(`INSERT INTO movements (account_id, occurred_on, amount, currency, flow_kind, note) VALUES (?, '2026-04-28', ?, 'usd', 'compra_usd', 'IRS TREAS 310 TAX REF')`)
        .run(accountId, refund).lastInsertRowid
    );
    const debit = Number(
      db
        .prepare(`INSERT INTO movements (account_id, occurred_on, amount, currency, flow_kind, note) VALUES (?, '2026-04-28', 50, 'usd', 'withdrawal_usd', 'x')`)
        .run(accountId).lastInsertRowid
    );
    expect(() => linkF1040Settlement({ taxYear: 2025, movementId: debit, description: "x" })).toThrow(/is a payment, the filed return asks for a refund/);
    linkF1040Settlement({ taxYear: 2025, movementId: credit, description: "IRS refund" });
    linkF1040Settlement({ taxYear: 2025, movementId: credit, description: "IRS refund" });
    expect(f1040Settlement(2025)).toMatchObject({
      expected: { kind: "refund", amount: refund },
      settled: refund,
      difference: 0,
      links: [{ kind: "refund", account_id: accountId, movement_id: credit, occurred_on: "2026-04-28", amount: refund }],
    });
    db.prepare(`DELETE FROM us_f1040_settlements`).run();
  });
});

describe("the 1040 by declared residency", () => {
  afterEach(() => {
    db.prepare(`DELETE FROM tax_residency_periods`).run();
    cleanup();
  });

  /** A Chilean resident until the day before `usFrom`, a US resident from it. */
  function declareMove(usFrom: string) {
    declareTaxResidency({ jurisdiction: "cl", fromDate: "1990-01-01" });
    declareTaxResidency({ jurisdiction: "us", fromDate: usFrom });
  }

  it("drafts a dual-status year: the resident part on the 1040, no standard deduction, the nonresident statement's US dividends at the withheld rate", () => {
    applyStubs(generatedStubs("2026-12-31"));
    declareMove("2026-07-01");
    const d = buildF1040Draft(2026, "2026-12-31");
    expect(d.residency).toEqual({ kind: "dual_status", from: "2026-07-01" });
    expect(d.residentWindow).toEqual({ fromYmd: "2026-07-01", throughYmd: "2026-12-31" });
    expect(d.lines["12"]).toBe(0);
    expect(d.notes).toEqual(expect.arrayContaining(["dual_status", "dual_status_statement_tax_line_16", "no_step_up_on_residency", "schedules_not_wired"]));
    // Every resident-part item falls on or after the residency day; the statement's before it.
    for (const x of [...d.interest, ...d.dividends]) expect(x.date >= "2026-07-01").toBe(true);
    const s = d.dualStatusStatement!;
    expect(s.rows.length).toBeGreaterThan(0);
    for (const r of s.rows) {
      expect(r.date < "2026-07-01").toBe(true);
      expect(r.ratePct).toBe(15);
    }
    expect(s.tax).toBe(Math.round(s.rows.reduce((a, r) => a + r.taxUsd, 0)));
    // Line 16 carries the statement's tax; 25c its withholding with the resident part's 1042-S.
    const ordinary = d.qdcgWorksheet ? d.qdcgWorksheet["25"] : usForm1040Tax(d.lines["15"]!, "single", 2026);
    expect(d.lines["16"]).toBe(ordinary + s.tax);
    expect(d.lines["25c"]).toBe(d.withholding1042S + s.withheld);
    expect(() => assertF1040Identities(d.lines, "dual", 2026)).not.toThrow();
    const p = buildF1040Payload(2026, "2026-12-31");
    expect(p).toMatchObject({ drafted: true, residency: { kind: "dual_status", from: "2026-07-01" } });
    expect(p.dual_status_statement?.rows.length).toBe(s.rows.length);
    expect(p.schedules.map((x) => x.form)).toEqual(expect.arrayContaining(["schedule_b", "schedule_d", "schedule_1", "schedule_2", "form_8960"]));
  });

  it("drafts a full resident year with its standard deduction, and no 1040 for a nonresident year (a Form 1040-NR filer)", () => {
    applyStubs(generatedStubs("2025-12-31"));
    declareMove("2025-01-01");
    const full = buildF1040Draft(2025, TODAY);
    expect(full.residency.kind).toBe("full");
    expect(full.lines["12"]).toBe(usTaxYear(2025).standardDeduction.single);
    expect(full.dualStatusStatement).toBeNull();
    // 2024: a Chilean resident all year with US stubs on file.
    expect(() => buildF1040Draft(2024, TODAY)).toThrow(/Form 1040-NR/);
    const p = buildF1040Payload(2024, TODAY);
    expect(p).toMatchObject({ drafted: false, not_drafted_reason: "nonresident_alien", rows: [], residency: { kind: "nonresident" } });
    expect(p.w2s).toHaveLength(1);
    expect(availableUsTaxYears(TODAY)).toEqual([2026, 2025, 2024]);
  });
});

describe("GET /api/tax-return/us", () => {
  let server: Server;
  let baseUrl: string;
  beforeAll(async () => {
    const app = express();
    registerTaxReturnRoutes(app);
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => resolve());
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    cleanup();
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  it("404s without US stubs, serves a listed year and refuses another", async () => {
    cleanup();
    expect((await fetch(`${baseUrl}/api/tax-return/us`)).status).toBe(404);
    // The second half of 2025 only: the F22 below declares these stubs as foreign salary, reajustada
    // by the official IPC, which the Vitest person's market holds for its own months only.
    applyStubs(generatedStubs("2025-12-31").filter((st) => st.payDate >= "2025-07-01"));
    const ok = await fetch(`${baseUrl}/api/tax-return/us?tax_year=2025`);
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { jurisdiction: string; tax_year: number; rows: { line: string }[]; w2s: unknown[] };
    expect(body).toMatchObject({ jurisdiction: "us", tax_year: 2025 });
    expect(body.w2s).toHaveLength(1);
    expect(body.rows.map((r) => r.line)).toEqual(expect.arrayContaining(["1a", "12", "15", "16", "24", "25a", "33"]));
    expect((await fetch(`${baseUrl}/api/tax-return/us?tax_year=2019`)).status).toBe(400);
    const f22 = (await (await fetch(`${baseUrl}/api/tax-return?tax_year=2026`)).json()) as { us_tax_year: number | null };
    expect(f22.us_tax_year).toBe(2025);
  });
});
