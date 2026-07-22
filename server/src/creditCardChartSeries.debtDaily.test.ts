import { describe, expect, it } from "vitest";
import { buildCcInstallmentDebtDailySeries } from "./creditCardChartSeries.js";
import { buildCcInstallmentPlanTail } from "./ccInstallmentDebtDaily.js";

describe("buildCcInstallmentDebtDailySeries", () => {
  it("ramps on purchase dates, drops on pay-by dates, null before the first event", () => {
    const dates = [
      "2026-01-05",
      "2026-01-10",
      "2026-01-11",
      "2026-02-09",
      "2026-02-10",
      "2026-02-11",
      "2026-03-15",
    ];
    const events = [
      { iso: "2026-01-10", clp: 300000 }, // contract, 3 cuotas of 100k
      { iso: "2026-02-10", clp: -100000 }, // first cuota pay-by
      { iso: "2026-03-10", clp: -100000 },
    ];
    expect(buildCcInstallmentDebtDailySeries(dates, events)).toEqual([
      null, // before any event
      300000, // full contract on purchase day
      300000,
      300000, // flat until pay-by
      200000, // cuota leaves on its pay-by
      200000,
      100000,
    ]);
  });

  it("clamps interest-rounding residue at zero and handles empty events", () => {
    const dates = ["2026-01-01", "2026-06-01"];
    expect(
      buildCcInstallmentDebtDailySeries(dates, [
        { iso: "2026-01-01", clp: 100 },
        { iso: "2026-02-10", clp: -101 },
      ])
    ).toEqual([100, 0]);
    expect(buildCcInstallmentDebtDailySeries(dates, [])).toEqual([null, null]);
  });

  it("walks future dates past the last event down to zero (plan tail grid)", () => {
    const dates = ["2026-02-10", "2026-03-10", "2026-04-10", "2026-05-10"];
    const events = [
      { iso: "2026-01-10", clp: 300000 },
      { iso: "2026-02-10", clp: -100000 },
      { iso: "2026-03-10", clp: -100000 },
      { iso: "2026-04-10", clp: -100000 },
    ];
    expect(buildCcInstallmentDebtDailySeries(dates, events)).toEqual([200000, 100000, 0, 0]);
  });
});

describe("buildCcInstallmentPlanTail", () => {
  // Contract of 300k on 2026-01-10, three 100k cuotas paid 02-10 / 03-10 / 04-10.
  const events = [
    { iso: "2026-01-10", clp: 300000 },
    { iso: "2026-02-10", clp: -100000 },
    { iso: "2026-03-10", clp: -100000 },
    { iso: "2026-04-10", clp: -100000 },
  ];
  const future = ["2026-01-20", "2026-02-09", "2026-02-10", "2026-02-11", "2026-03-10", "2026-04-10"];

  it("rides the open non-installment carry until the pay-by, then coincides with plan debt", () => {
    // owed today (350k) = plan debt (300k) + 50k of unpaid únicos billed this open cycle.
    const tail = buildCcInstallmentPlanTail("2026-01-15", future, events, 350000, "2026-02-10");
    expect(tail).toEqual([
      { as_of_date: "2026-01-20", plan_debt_clp: 300000, balance_clp: 350000 },
      { as_of_date: "2026-02-09", plan_debt_clp: 300000, balance_clp: 350000 },
      // On the open pay-by the cuota leaves plan debt AND the carry is paid off → lines meet.
      { as_of_date: "2026-02-10", plan_debt_clp: 200000, balance_clp: 200000 },
      { as_of_date: "2026-02-11", plan_debt_clp: 200000, balance_clp: 200000 },
      { as_of_date: "2026-03-10", plan_debt_clp: 100000, balance_clp: 100000 },
      { as_of_date: "2026-04-10", plan_debt_clp: 0, balance_clp: 0 },
    ]);
  });

  it("has no carry when owed today is unknown (balance == plan debt everywhere)", () => {
    const tail = buildCcInstallmentPlanTail("2026-01-15", future, events, null, "2026-02-10");
    expect(tail.every((p) => p.balance_clp === p.plan_debt_clp)).toBe(true);
  });

  it("returns an empty tail when there are no future dates", () => {
    expect(buildCcInstallmentPlanTail("2026-01-15", [], events, 350000, "2026-02-10")).toEqual([]);
  });
});
