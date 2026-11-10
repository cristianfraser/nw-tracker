import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { employmentPayslipsKind, type UsPayslip } from "nw-tracker-contracts";
import { db } from "../db.js";
import { computeF22Tax } from "./chain.js";
import { buildF22Draft } from "./draft.js";
import { foreignInterestForYear, foreignSalaryForYear } from "./foreignIncome.js";
import { f22ForeignSalaryCreditCap } from "./identities.js";
import { buildF1040Draft } from "../us1040/draft.js";
import { FOREIGN_TAX_CREDIT_CAP } from "../legalParameters.js";
import { applyEmploymentPayslips } from "../payslipsApply.js";
import type { UsdFxDisposalLoader } from "./usdFx.js";

const UTA = 800_000;
// A synthetic open year the Vitest person does not reach: the IPC reajuste is zero past the latest
// month, and the 1040 drafts it under the latest listed US law.
const INCOME_YEAR = 2096;
const TODAY = `${INCOME_YEAR}-12-15`;
const PREFIX = "vitest-f22-foreign/";
const OBSERVADO = 900;
const noUsd: UsdFxDisposalLoader = () => ({ disposals: [], openLots: [] });

const PAY_DATES = [`${INCOME_YEAR}-03-06`, `${INCOME_YEAR}-06-05`, `${INCOME_YEAR}-09-04`];

/** A plain stub: wages, federal withholding, Social Security and Medicare at their rates. */
function stub(payDate: string): UsPayslip {
  const gross = 20_000;
  const lines = [
    { side: "haber" as const, label: "Regular Pay", amount: gross },
    { side: "descuento" as const, label: "Federal Income Tax", amount: 3_000 },
    { side: "descuento" as const, label: "Social Security", amount: 1_240 },
    { side: "descuento" as const, label: "Medicare", amount: 290 },
  ];
  const deductions = 3_000 + 1_240 + 290;
  return {
    jurisdiction: "us",
    pay_period: "biweekly",
    document: `${PREFIX}${payDate}.pdf`,
    period_month: payDate.slice(0, 7),
    pay_date: payDate,
    period_start: payDate,
    period_end: payDate,
    employer: { name: "VITEST WIDGETS INC", ein: "89-0000002" },
    kind: "salary",
    w4: { filing_status: "single" },
    gross_pay: gross,
    total_deductions: deductions,
    net_pay: gross - deductions,
    lines: lines.map((l, i) => ({ position: i, ...l })),
  };
}

let ibkrAccount = 0;
const cleanup = () => {
  db.prepare(`DELETE FROM payroll_work_earnings WHERE source_pdf LIKE '${PREFIX}%'`).run();
  if (ibkrAccount) {
    db.prepare(`DELETE FROM movements WHERE account_id = ?`).run(ibkrAccount);
    db.prepare(`DELETE FROM account_roles WHERE account_id = ?`).run(ibkrAccount);
    db.prepare(`DELETE FROM accounts WHERE id = ?`).run(ibkrAccount);
  }
  db.prepare(`DELETE FROM fx_daily_bcentral WHERE date LIKE ?`).run(`${INCOME_YEAR}-%`);
};

describe("the F22 chain with a foreign salary", () => {
  it("adds 1030 and its 748 to 158, and credits 1018 up to the IGC on that income (no refund)", () => {
    const base = { 1098: 10_000_000, 162: 200_000 };
    const plain = computeF22Tax(base, UTA, 2030);
    const salary = { 1030: 80_000_000, 748: 15_000_000, 161: 90_000_000 };
    const out = computeF22Tax({ ...base, ...salary }, UTA, 2030, { foreignSalaryCredit: { creditClp: 15_000_000, incomeClp: 95_000_000 } });
    expect(out[158]! - plain[158]!).toBe(95_000_000);
    // Circular 31/2021 §1.2.2.2.1 b): the IGC × the income's share of the base, the share a percentage with one decimal.
    const cap = f22ForeignSalaryCreditCap(out, 95_000_000);
    const sharePct = Math.round((95_000_000 / out[158]!) * 1000) / 10;
    expect(cap).toBe(Math.round((out[157]! * sharePct) / 100));
    // The annex's own example: $6.243.165 × 22,0 % [$12.391.313 / $56.391.313] = 1.373.496.
    expect(f22ForeignSalaryCreditCap({ 157: 6_243_165, 158: 56_391_313 }, 12_391_313)).toBe(1_373_496);
    expect(out[1018]).toBe(Math.min(15_000_000, cap));
    expect(out[304]).toBe(out[157]! - out[1018]! - 200_000);
    // A credit above the IGC on the income is capped there: the excess is lost, never refunded.
    const big = computeF22Tax({ ...base, ...salary }, UTA, 2030, { foreignSalaryCredit: { creditClp: 90_000_000, incomeClp: 95_000_000 } });
    expect(big[1018]).toBe(f22ForeignSalaryCreditCap(big, 95_000_000));
    // The dividends' credit already in 1018 stays; the salary's adds to it.
    const both = computeF22Tax({ ...base, ...salary, 1018: 50_000 }, UTA, 2030, { foreignSalaryCredit: { creditClp: 15_000_000, incomeClp: 95_000_000 } });
    expect(both[1018]).toBe(out[1018]! + 50_000);
  });

  it("reads a filed 746 (línea 49, a company's pass-through art. 41 A credit) as a credit in 304 and never drafts it", () => {
    const base = { 1098: 10_000_000, 162: 200_000, 1104: 500_000, 748: 75_000, 1018: 75_000 };
    const plain = computeF22Tax(base, UTA, 2030);
    const filed746 = computeF22Tax({ ...base, 746: 40_000 }, UTA, 2030);
    expect(filed746[304]).toBe(plain[304]! - 40_000);
    expect(filed746[1018]).toBe(75_000);
    expect(plain[746]).toBeUndefined();
  });
});

describe("foreign income in the F22 draft", () => {
  beforeAll(() => {
    cleanup();
    for (const d of [...PAY_DATES, `${INCOME_YEAR}-11-28`, TODAY]) {
      db.prepare(`INSERT INTO fx_daily_bcentral (date, clp_per_usd) VALUES (?, ?)`).run(d, OBSERVADO);
    }
    applyEmploymentPayslips(employmentPayslipsKind.payload.parse({ parser_version: "vitest", payslips: PAY_DATES.map(stub) }));
    ibkrAccount = Number(
      db.prepare(`INSERT INTO accounts (name, asset_group_id) VALUES ('Vitest IBKR USD', (SELECT id FROM asset_groups LIMIT 1))`).run().lastInsertRowid
    );
    db.prepare(`INSERT INTO account_roles (account_id, role, param) VALUES (?, 'broker_cash', 'ibkr|usd')`).run(ibkrAccount);
    const interest = db.prepare(
      `INSERT INTO movements (account_id, amount, currency, occurred_on, note, flow_kind) VALUES (?, ?, 'usd', ?, 'vitest interest', 'savings_earnings')`
    );
    interest.run(ibkrAccount, 12.5, `${INCOME_YEAR}-04-30`);
    interest.run(ibkrAccount, 7.5, `${INCOME_YEAR}-11-28`);
  });

  afterAll(cleanup);

  it("declares the gross salary less the US tax only (FICA stays in), at the year-end observado, the tax at line 24", () => {
    const yearEnd = { observado: OBSERVADO + 50, provisional: true };
    const s = foreignSalaryForYear(INCOME_YEAR, TODAY, yearEnd);
    expect(s.stubs).toHaveLength(3);
    // Circular 31/2021 §1.2.2.2.2 a) i): only Chilean-law contributions come off an art. 42 N°1 income.
    expect(s.incomeUsd).toBe(3 * 20_000);
    expect(s.stubs.map((x) => x.ficaUsd)).toEqual([1_530, 1_530, 1_530]);
    // Art. 41 A N°7 letra a) (Circular 31 §1.3.2.2): the year-end parity for a person, no reajuste.
    expect(s.stubs.every((x) => x.observado === yearEnd.observado)).toBe(true);
    expect(s.grossClp).toBe(Math.round(s.incomeUsd * yearEnd.observado));
    const line24 = buildF1040Draft(INCOME_YEAR, TODAY).lines["24"]!;
    expect(s.usTaxUsd).toBe(line24);
    expect(s.usTaxSource).toBe("draft");
    expect(s.usTaxClp).toBe(Math.round(line24 * yearEnd.observado));
    expect(s.netClp).toBe(s.grossClp - s.usTaxClp);
    expect(s.creditClp).toBe(Math.round(Math.min(s.usTaxClp, FOREIGN_TAX_CREDIT_CAP * s.grossClp)));
    expect(s.provisional).toBe(true);
    expect(() => foreignSalaryForYear(INCOME_YEAR, TODAY, { observado: 0, provisional: false })).toThrow(/observado/);
  });

  it("sums the foreign broker's interest at the year-end observado", () => {
    const i = foreignInterestForYear(INCOME_YEAR, OBSERVADO);
    expect(i.lines).toHaveLength(2);
    expect(i.usd).toBe(20);
    expect(i.clp).toBe(20 * OBSERVADO);
  });

  it("drafts 1030 in línea 13 (161 = 1098 + 1030), the credit in 748 / 1018, the interest in 1104, all at one year-end rate", () => {
    const d = buildF22Draft(INCOME_YEAR + 1, TODAY, { usdFx: { load: noUsd } });
    const s = d.foreignSalary;
    expect(d.taxComputed).toBe(true);
    expect(s.grossClp).toBe(Math.round(3 * 20_000 * OBSERVADO));
    expect(s.stubs[0]!.observado).toBe(OBSERVADO);
    expect(d.draft[1030]).toBe(s.netClp);
    expect(d.draft[161]).toBe((d.draft[1098] ?? 0) + s.netClp);
    expect(d.draft[748]).toBe(s.creditClp);
    expect(d.foreignSalaryCredit).not.toBeNull();
    expect(d.draft[1018]).toBe(d.foreignSalaryCredit!.appliedClp);
    expect(d.foreignSalaryCredit!.appliedClp).toBe(Math.min(s.creditClp, d.foreignSalaryCredit!.capClp));
    expect(d.draft[1104]).toBe(d.foreignInterest.clp);
    expect(d.draft[158]).toBe(s.netClp + s.creditClp + d.foreignInterest.clp);
    expect(d.draft[304]).toBe(d.draft[157]! - d.draft[1018]!);
  });
});

describe("DJ 1898 from several lenders", () => {
  const DJ_TAX_YEAR = 2095;
  const today = `${DJ_TAX_YEAR - 1}-12-20`;
  const source = "vitest:f22-two-lenders";
  const clean = () => {
    db.prepare(`DELETE FROM sii_informed_dj WHERE source_file = ?`).run(source);
    db.prepare(`DELETE FROM fx_daily_bcentral WHERE date = ?`).run(today);
  };
  beforeAll(() => {
    clean();
    db.prepare(`INSERT INTO fx_daily_bcentral (date, clp_per_usd) VALUES (?, ?)`).run(today, OBSERVADO);
    const dj = db.prepare(`INSERT INTO sii_informed_dj (tax_year, dj_code, field, value, source_file) VALUES (?, 1898, ?, ?, ?)`);
    dj.run(DJ_TAX_YEAR, "A: Banco Uno / Monto Actualizado de los Intereses Pagados ($) en Dividendo", "1.200.000", source);
    dj.run(DJ_TAX_YEAR, "B: Banco Dos / Monto Actualizado de los Intereses Pagados ($) en Dividendo", "5.300.000", source);
  });
  afterAll(clean);

  it("sums every lender's interest into 751; art. 55 bis caps the total", () => {
    const d = buildF22Draft(DJ_TAX_YEAR, today, { usdFx: { load: noUsd } });
    expect(d.informed[751]).toBe(6_500_000);
    expect(d.draft[751]).toBe(6_500_000);
    expect(d.draft[750]).toBe(Math.min(6_500_000, 8 * d.utaClp));
  });
});
