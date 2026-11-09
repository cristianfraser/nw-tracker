/** The demo's US pay stubs: the payroll math the generator writes, checked against the app's US law. */
import { describe, expect, it } from "vitest";
import {
  usMedicareTax,
  usPercentageMethodWithholding,
  usSocialSecurityTax,
  usSupplementalWithholding,
  usTaxYear,
} from "../usLegalParameters.js";
import type { UsW2Job } from "./person.js";
import { newUsPayrollYtd, usAnnualSalary, usPayDates, usPayStub, usW2sOfStubs } from "./usPayroll.js";

const JOB: UsW2Job = {
  kind: "us_w2",
  id: "vitest",
  employer: "Example Labs Inc.",
  ein: "89-0000001",
  bankName: "EXAMPLE LABS PAYROLL",
  from: "2024-04",
  to: null,
  firstPayDate: "2024-04-19",
  annualSalaryUsd: 130_000,
  yearlyRaise: 0.05,
  raiseMonth: 4,
  bonus: { month: 3, fraction: 0.1 },
  payFrequency: "biweekly",
  retirement401kRate: 0.06,
  employerMatchRate: 0.04,
  medicalUsd: 100,
  dentalVisionUsd: 10,
  hsaUsd: 50,
  w4FilingStatus: "single",
};

const sum = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b * 100, 0)) / 100;

describe("the demo's US payroll", () => {
  it("pays every 14 days, the business day before when the market is closed", () => {
    const dates = usPayDates(JOB, "2025-07-31");
    expect(dates[0]).toEqual({ nominal: "2024-04-19", paid: "2024-04-19" });
    expect(dates.every((d, i) => i === 0 || Date.parse(d.nominal) - Date.parse(dates[i - 1]!.nominal) === 14 * 86_400_000)).toBe(true);
    // Good Friday 2025 (2025-04-18) is a payday the market is closed: paid on Thursday.
    expect(dates.find((d) => d.nominal === "2025-04-18")).toEqual({ nominal: "2025-04-18", paid: "2025-04-17" });
  });

  it("raises the salary each April after the first year", () => {
    expect(usAnnualSalary(JOB, "2025-03-28")).toBe(130_000);
    expect(usAnnualSalary(JOB, "2025-04-11")).toBe(136_500);
    expect(usAnnualSalary(JOB, "2026-04-10")).toBe(Math.round(130_000 * 1.05 * 1.05));
  });

  it("computes a stub the way the payslip checks read it, its lines adding up", () => {
    const ytd = newUsPayrollYtd();
    const s = usPayStub(JOB, { nominal: "2024-04-19", paid: "2024-04-19" }, ytd);
    const regular = Math.round((130_000 / 26) * 100) / 100;
    expect(s.regular).toBe(regular);
    expect(s.bonus).toBe(0);
    expect(s.k401).toBe(Math.round(regular * 0.06 * 100) / 100);
    expect(s.match).toBe(Math.round(regular * 0.04 * 100) / 100);
    const fica = Math.round((regular - 160) * 100) / 100;
    expect(s.socialSecurity).toBe(usSocialSecurityTax(fica, 0, 2024));
    expect(s.medicare).toBe(usMedicareTax(fica, 0, 2024));
    expect(s.federal).toBe(usPercentageMethodWithholding(Math.round((regular - s.k401 - 160) * 100) / 100, "biweekly", "single", 2024));
    const deductions = s.lines.filter((l) => l.side === "descuento").map((l) => l.amount);
    expect(sum(s.lines.filter((l) => l.side === "haber").map((l) => l.amount))).toBe(s.gross);
    expect(sum(deductions)).toBe(s.deductions);
    expect(Math.round((s.gross - s.deductions) * 100) / 100).toBe(s.net);
    expect(s.lines.find((l) => l.side === "memo")).toEqual({ side: "memo", label: "401(k) Employer Match", amount: s.match });
    expect(s.periodEnd).toBe("2024-04-14");
    expect(s.periodStart).toBe("2024-04-01");
    expect(ytd).toMatchObject({ year: 2024, ficaWages: fica, deferrals: s.k401 });
  });

  it("pays the bonus with March's first check from the second year, at the supplemental rate", () => {
    const dates = usPayDates(JOB, "2025-03-31");
    const ytd = newUsPayrollYtd();
    const stubs = dates.map((d) => usPayStub(JOB, d, ytd));
    const march = stubs.filter((s) => s.payDate.startsWith("2025-03"));
    expect(march.map((s) => s.bonus)).toEqual([13_000, 0]);
    const b = march[0]!;
    const regularTaxable = Math.round((b.regular - b.k401 - 160) * 100) / 100;
    expect(b.federal).toBe(
      Math.round((usPercentageMethodWithholding(regularTaxable, "biweekly", "single", 2025) + usSupplementalWithholding(13_000, 0, 2025)) * 100) / 100
    );
    expect(stubs.filter((s) => s.payDate.startsWith("2024-03")).length).toBe(0);
  });

  it("stops the 401(k) deferral at the year's limit", () => {
    const rich = { ...JOB, annualSalaryUsd: 600_000, bonus: null };
    const ytd = newUsPayrollYtd();
    const stubs = usPayDates(rich, "2024-12-31").map((d) => usPayStub(rich, d, ytd));
    expect(sum(stubs.map((s) => s.k401))).toBe(usTaxYear(2024).elective401kLimit);
    expect(stubs.at(-1)!.k401).toBe(0);
    expect(stubs.at(-1)!.match).toBe(0);
  });

  it("adds the year's stubs into its W-2", () => {
    const ytd = newUsPayrollYtd();
    const stubs = usPayDates(JOB, "2024-12-31").map((d) => usPayStub(JOB, d, ytd));
    const [w] = usW2sOfStubs(stubs);
    expect(w).toMatchObject({ year: 2024, ein: JOB.ein });
    expect(w!.federalWithheld).toBe(sum(stubs.map((s) => s.federal)));
    expect(w!.box12D).toBe(sum(stubs.map((s) => s.k401)));
    expect(w!.wages).toBe(sum(stubs.map((s) => s.gross - s.k401 - 160)));
  });
});
