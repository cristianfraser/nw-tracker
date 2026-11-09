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
import { db } from "./db.js";
import { availableUsTaxYears, buildF1040Draft } from "./f1040Draft.js";
import { f1040Settlement, filedF1040, linkF1040Settlement, recordFiledF1040 } from "./f1040Filed.js";
import { assertF1040Identities, computeF1040Lines, type F1040Lines } from "./f1040Identities.js";
import { buildF1040Payload } from "./f1040Payload.js";
import { applyEmploymentPayslips } from "./payslipsApply.js";
import { registerTaxReturnRoutes } from "./routes/taxReturn.js";
import { usBracketTax, usForm1040Tax, usTaxYear } from "./usLegalParameters.js";
import { usW2sFromStubLines, type UsW2Stub } from "./usW2.js";
import { usPayDates, usPayStub, usW2StubOf, usW2sOfStubs, newUsPayrollYtd, type UsPayStub } from "./demoData/usPayroll.js";
import type { UsW2Job } from "./demoData/person.js";

const PREFIX = "vitest-f1040/";
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
    db.prepare(`DELETE FROM accounts WHERE id = ?`).run(id);
  }
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
    const lines = computeF1040Lines({
      wages1a: 120_000,
      standardDeduction12: 15_750,
      taxOn: (t) => usForm1040Tax(t, "single", 2025),
      otherTaxes23: 0,
      withholdingW2_25a: 20_000,
      withholdingOther25c: 0,
      schedule3Credits31: 0,
    });
    expect(lines["15"]).toBe(104_250);
    expect(lines["16"]).toBe(Math.round(usBracketTax(104_250, usTaxYear(2025).brackets.single)));
    expect(lines["24"]).toBe(lines["16"]);
    expect(lines["34"]).toBe(Math.max(0, 20_000 - lines["24"]));
    expect(lines["35a"]).toBe(lines["34"]);
    expect(lines["37"]).toBe(Math.max(0, lines["24"] - 20_000));
    expect(() => assertF1040Identities(lines, "ok")).not.toThrow();
    expect(() => assertF1040Identities({ ...lines, "15": lines["15"] + 1 }, "bad")).toThrow(/line 15 is/);
    expect(() => assertF1040Identities({ ...lines, "99": 1 } as F1040Lines, "bad")).toThrow(/unknown line 99/);
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
    expect(d.notes).toEqual(["no_state_return"]);
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
    const refund = Math.round(w2.federalWithheld) - (d.lines["24"] ?? 0);
    expect(refund > 0 ? d.lines["35a"] : d.lines["37"]).toBe(Math.abs(refund));
    // The first US year starts in April: a dual-status year drafted as a full resident year.
    expect(buildF1040Draft(2024, TODAY).notes).toEqual(["no_state_return", "first_year_full_resident"]);
    expect(availableUsTaxYears(TODAY)).toEqual([2026, 2025, 2024]);
  });

  it("throws for a closed year the law table does not list; an open one takes the latest year's law", () => {
    expect(() => buildF1040Draft(2023, TODAY)).toThrow(/no figures for 2023/);
    applyStubs(generatedStubs("2025-12-31"));
    const open = buildF1040Draft(2027, "2027-02-01");
    expect(open).toMatchObject({ provisional: true, lawYear: 2026, stubs: 0, filingStatus: "single" });
    expect(open.notes).toEqual(["no_state_return", "open_year", "law_provisional"]);
    expect(() => buildF1040Draft(2027, TODAY)).toThrow(/not started/);
  });

  it("compares a filed return with the draft and links its settlement", () => {
    applyStubs(generatedStubs("2025-12-31"));
    const d = buildF1040Draft(2025, TODAY);
    // Filed with $200 less tax than the draft computes (the draft owes a little: the bonus is withheld at 22 %).
    const filedLines = computeF1040Lines({
      wages1a: d.lines["1a"]!,
      standardDeduction12: d.lines["12"]!,
      taxOn: (t) => usForm1040Tax(t, "single", 2025) - 200,
      otherTaxes23: 0,
      withholdingW2_25a: d.lines["25a"]!,
      withholdingOther25c: 0,
      schedule3Credits31: 0,
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
    applyStubs(generatedStubs("2025-12-31"));
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
