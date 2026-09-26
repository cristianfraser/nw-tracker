import { describe, expect, it } from "vitest";
import { buildCcInstallmentDebtDailySeries } from "./creditCardChartSeries.js";
import {
  buildCcInstallmentPlanTail,
  sumCcPlanTails,
  sumNullableDailySeries,
} from "./ccInstallmentDebtDaily.js";

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

  it("drops a closed facturación's unpaid rest on its own pay-by, the open cycle's charges on the open one", () => {
    // Owed today 470k = plan debt 300k + 150k left of the December facturado (due 01-20)
    // + 20k charged this cycle (due with the open facturación, 02-10).
    const grid = ["2026-01-19", "2026-01-20", "2026-02-09", "2026-02-10"];
    const tail = buildCcInstallmentPlanTail("2026-01-15", grid, events, 470000, "2026-02-10", {
      payByIso: "2026-01-20",
      openCycleChargesClp: 20000,
    });
    expect(tail).toEqual([
      { as_of_date: "2026-01-19", plan_debt_clp: 300000, balance_clp: 470000 },
      { as_of_date: "2026-01-20", plan_debt_clp: 300000, balance_clp: 320000 },
      { as_of_date: "2026-02-09", plan_debt_clp: 300000, balance_clp: 320000 },
      { as_of_date: "2026-02-10", plan_debt_clp: 200000, balance_clp: 200000 },
    ]);
  });

  it("leaves only the open cycle's charges once the closed facturado is paid early", () => {
    // Paid ahead of the pay-by: owed 310k = plan debt 300k + 10k, less than the cycle's 20k of
    // charges (a refund netted in) — the closed part is 0, never negative.
    const tail = buildCcInstallmentPlanTail(
      "2026-01-15",
      ["2026-01-19", "2026-01-20", "2026-02-10"],
      events,
      310000,
      "2026-02-10",
      { payByIso: "2026-01-20", openCycleChargesClp: 20000 }
    );
    expect(tail.map((p) => p.balance_clp)).toEqual([310000, 310000, 200000]);
  });
});

describe("sumNullableDailySeries — group-scope «deuda en cuotas» / owed sums", () => {
  it("is null only where every member is null, else the sum of the finite members", () => {
    // Card A's plan starts on day 2, card B's on day 3 — the group line starts with A.
    const a = [null, 300000, 300000, 200000];
    const b = [null, null, 120000, 120000];
    expect(sumNullableDailySeries([a, b], 4)).toEqual([null, 300000, 420000, 320000]);
  });

  it("an empty member set is all-null; a length mismatch throws (one shared grid)", () => {
    expect(sumNullableDailySeries([], 3)).toEqual([null, null, null]);
    expect(() => sumNullableDailySeries([[1, 2]], 3)).toThrow(/member length 2 != grid 3/);
  });
});

describe("sumCcPlanTails — group-scope plan tail over one shared grid", () => {
  const eventsA = [
    { iso: "2026-01-10", clp: 300000 },
    { iso: "2026-02-10", clp: -100000 },
    { iso: "2026-03-10", clp: -100000 },
    { iso: "2026-04-10", clp: -100000 },
  ];
  // Card B settled its plan before today; only its open-cycle carry (20k) remains, paid 02-10.
  const eventsB = [
    { iso: "2025-11-10", clp: 60000 },
    { iso: "2025-12-10", clp: -60000 },
  ];
  const grid = ["2026-01-20", "2026-02-10", "2026-03-10", "2026-04-10"];

  it("sums per day: an active plan plus a settled member's carry until its own pay-by", () => {
    const a = buildCcInstallmentPlanTail("2026-01-15", grid, eventsA, 350000, "2026-02-10");
    const b = buildCcInstallmentPlanTail("2026-01-15", grid, eventsB, 20000, "2026-02-10");
    expect(b).toEqual([
      { as_of_date: "2026-01-20", plan_debt_clp: 0, balance_clp: 20000 },
      { as_of_date: "2026-02-10", plan_debt_clp: 0, balance_clp: 0 },
      { as_of_date: "2026-03-10", plan_debt_clp: 0, balance_clp: 0 },
      { as_of_date: "2026-04-10", plan_debt_clp: 0, balance_clp: 0 },
    ]);
    expect(sumCcPlanTails([a, b])).toEqual([
      { as_of_date: "2026-01-20", plan_debt_clp: 300000, balance_clp: 370000 },
      { as_of_date: "2026-02-10", plan_debt_clp: 200000, balance_clp: 200000 },
      { as_of_date: "2026-03-10", plan_debt_clp: 100000, balance_clp: 100000 },
      { as_of_date: "2026-04-10", plan_debt_clp: 0, balance_clp: 0 },
    ]);
  });

  it("a single member sums to itself; differing grids throw", () => {
    const a = buildCcInstallmentPlanTail("2026-01-15", grid, eventsA, null, null);
    expect(sumCcPlanTails([a])).toEqual(a);
    expect(sumCcPlanTails([])).toEqual([]);
    const shifted = buildCcInstallmentPlanTail("2026-01-15", grid.slice(1), eventsA, null, null);
    expect(() => sumCcPlanTails([a, shifted])).toThrow(/member grids differ/);
  });
});
