import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "./db.js";
import {
  buildRealEstateExpensesPayload,
  chartPartsOf,
  createRealEstatePlace,
  mortgageCuotaBillMonths,
  spreadOverCoveredMonths,
} from "./flowsRealEstateExpenses.js";

describe("mortgageCuotaBillMonths", () => {
  it("maps on-schedule cuotas to their payment month", () => {
    expect(
      mortgageCuotaBillMonths([
        { cuota: "5", occurred_on: "2024-07-11" },
        { cuota: "6", occurred_on: "2024-08-11" },
        { cuota: "7", occurred_on: "2024-09-12" },
      ])
    ).toEqual(["2024-07", "2024-08", "2024-09"]);
  });

  it("skip-then-double-payment lands the late cuota in its scheduled month", () => {
    // Real-world shape: Jan skipped, both cuotas paid in Feb.
    expect(
      mortgageCuotaBillMonths([
        { cuota: "10", occurred_on: "2024-12-11" },
        { cuota: "11", occurred_on: "2025-02-10" },
        { cuota: "12", occurred_on: "2025-02-11" },
        { cuota: "13", occurred_on: "2025-03-11" },
      ])
    ).toEqual(["2024-12", "2025-01", "2025-02", "2025-03"]);
  });

  it("late same-month payment (after the 11th) stays in its scheduled month", () => {
    expect(
      mortgageCuotaBillMonths([
        { cuota: "20", occurred_on: "2025-10-11" },
        { cuota: "21", occurred_on: "2025-11-25" },
        { cuota: "22", occurred_on: "2025-12-11" },
      ])
    ).toEqual(["2025-10", "2025-11", "2025-12"]);
  });

  it("anchor vote tie resolves to the smaller anchor (payments run late, never early)", () => {
    expect(
      mortgageCuotaBillMonths([
        { cuota: "5", occurred_on: "2024-07-11" },
        { cuota: "6", occurred_on: "2024-09-05" },
      ])
    ).toEqual(["2024-07", "2024-08"]);
  });

  it("empty ledger yields no months", () => {
    expect(mortgageCuotaBillMonths([])).toEqual([]);
  });

  it("throws on non-numeric cuota", () => {
    expect(() =>
      mortgageCuotaBillMonths([{ cuota: "pie", occurred_on: "2024-02-27" }])
    ).toThrow(/non-numeric/);
  });

  it("throws on duplicate cuota numbers", () => {
    expect(() =>
      mortgageCuotaBillMonths([
        { cuota: "5", occurred_on: "2024-07-11" },
        { cuota: "5", occurred_on: "2024-08-11" },
        { cuota: "6", occurred_on: "2024-08-12" },
      ])
    ).toThrow(/duplicate scheduled month/);
  });

  it("throws when a payment is months off its schedule", () => {
    expect(() =>
      mortgageCuotaBillMonths([
        { cuota: "5", occurred_on: "2024-07-11" },
        { cuota: "6", occurred_on: "2024-08-11" },
        { cuota: "7", occurred_on: "2024-09-11" },
        { cuota: "8", occurred_on: "2025-04-11" },
      ])
    ).toThrow(/off its scheduled month/);
  });
});

describe("buildRealEstateExpensesPayload", () => {
  it("returns slots with bill_month", () => {
    const payload = buildRealEstateExpensesPayload();
    for (const slot of payload.slots) {
      expect(slot.bill_month).toMatch(/^\d{4}-\d{2}$/);
      expect(typeof slot.can_link).toBe("boolean");
    }
  });

  it("total_clp matches sum of slot display amounts", () => {
    const payload = buildRealEstateExpensesPayload();
    const sum = payload.slots.reduce((s, sl) => s + sl.display_amount_clp, 0);
    expect(payload.total_clp).toBe(sum);
  });
});

describe("real-estate chart scopes", () => {
  const PLACES = [
    { slug: "vitest_chart_early", label: "Vitest early", activeFrom: "2019-01", activeTo: "2019-03" },
    { slug: "vitest_chart_late", label: "Vitest late", activeFrom: "2019-04" },
  ];
  const BILLS: [string, string, string, number][] = [
    ["vitest_chart_early", "2019-01-31", "rent", 100_000],
    ["vitest_chart_early", "2019-03-31", "electricidad", 30_000],
    ["vitest_chart_late", "2019-05-31", "rent", 200_000],
    ["vitest_chart_late", "2019-05-31", "gas", 20_000],
    ["vitest_chart_late", "2019-07-31", "internet", 15_000],
  ];
  const cleanup = () => {
    db.prepare(
      `DELETE FROM expense_entries WHERE expense_account_id IN (SELECT id FROM expense_accounts WHERE slug LIKE 'vitest_chart_%')`
    ).run();
    db.prepare(`DELETE FROM expense_accounts WHERE slug LIKE 'vitest_chart_%'`).run();
  };
  beforeAll(() => {
    cleanup();
    for (const p of PLACES) createRealEstatePlace(p);
    const ins = db.prepare(
      `INSERT INTO expense_entries (amount_clp, spent_on, category, note, expense_account_id)
       VALUES (?, ?, ?, 'vitest chart', (SELECT id FROM expense_accounts WHERE slug = ?))`
    );
    for (const [slug, spentOn, kind, amount] of BILLS) ins.run(amount, spentOn, kind, slug);
  });
  afterAll(cleanup);

  it("a place's scope runs from its first to its last bill, every point summing its series", () => {
    const payload = buildRealEstateExpensesPayload();
    const early = payload.chart_scopes.vitest_chart_early!;
    expect(early.points.map((p) => p.as_of_date)).toEqual(["2019-01-31", "2019-02-28", "2019-03-31"]);
    expect(early.series.map((s) => s.data_key)).toEqual(["vitest_chart_early__rent", "vitest_chart_early__electricidad"]);
    const late = payload.chart_scopes.vitest_chart_late!;
    expect(late.points.at(-1)?.as_of_date).toBe("2019-07-31");
    expect(late.points[0]).toMatchObject({
      as_of_date: "2019-05-31",
      total: 220_000,
      vitest_chart_late__rent: 200_000,
      vitest_chart_late__gas: 20_000,
      vitest_chart_late__internet: 0,
    });
    for (const chart of Object.values(payload.chart_scopes)) {
      for (const pt of chart.points) {
        expect(chart.series.reduce((acc, s) => acc + Number(pt[s.data_key]), 0)).toBe(pt.total);
      }
    }
  });

  it("stacks by place in date order, then kind (gas and contribuciones last), schemes alternating by place", () => {
    const all = buildRealEstateExpensesPayload().chart_scopes.all!;
    const ours = all.series.filter((s) => s.place_slug.startsWith("vitest_chart_"));
    expect(ours.map((s) => [s.data_key, s.scheme])).toEqual([
      ["vitest_chart_early__rent", expect.any(String)],
      ["vitest_chart_early__electricidad", expect.any(String)],
      ["vitest_chart_late__rent", expect.any(String)],
      ["vitest_chart_late__internet", expect.any(String)],
      ["vitest_chart_late__gas", expect.any(String)],
    ]);
    expect(ours[0]!.scheme).not.toBe(ours[2]!.scheme);
    expect(ours[0]!.scheme).toBe(ours[1]!.scheme);
  });
});

describe("spreadOverCoveredMonths", () => {
  it("keeps a one-month bill in its month", () => {
    expect(spreadOverCoveredMonths({ bill_month: "2023-06", months_covered: 1, display_amount_clp: 84_787 })).toEqual([
      { month: "2023-06", amount: 84_787 },
    ]);
  });

  it("divides a payment over the months ending at its bill month, the last taking the remainder", () => {
    expect(spreadOverCoveredMonths({ bill_month: "2024-01", months_covered: 3, display_amount_clp: 100_000 })).toEqual([
      { month: "2023-11", amount: 33_333 },
      { month: "2023-12", amount: 33_333 },
      { month: "2024-01", amount: 33_334 },
    ]);
  });

  it("throws on a covered count that is not a positive integer", () => {
    expect(() => spreadOverCoveredMonths({ bill_month: "2024-01", months_covered: 0, display_amount_clp: 1 })).toThrow();
  });
});

describe("chartPartsOf", () => {
  const base = {
    expense_entry_id: null,
    account_slug: "depto",
    bill_month: "2036-10",
    spent_on: "2036-10-11",
    expected_amount_clp: 0,
    link: null,
    broken_link: null,
    note: null,
    kwh: null,
    m3: null,
    months_covered: 1,
    covers_from: "2036-10",
    can_link: false,
  };

  it("splits a mortgage cuota into amortization, extra amortization and carrying", () => {
    const parts = chartPartsOf({
      ...base,
      kind: "mortgage",
      display_amount_clp: 700_000,
      mortgage_parts: { amortization_clp: 100_000, extra_amortization_clp: 350_000, carrying_clp: 250_000 },
    });
    expect(parts).toEqual([
      { kind: "mortgage_amortization", amount: 100_000 },
      { kind: "mortgage_extra_amortization", amount: 350_000 },
      { kind: "mortgage_carrying", amount: 250_000 },
    ]);
  });

  it("throws on a mortgage cuota without parts, and on a kind the chart does not know", () => {
    expect(() => chartPartsOf({ ...base, kind: "mortgage", display_amount_clp: 1, mortgage_parts: null })).toThrow();
    expect(() => chartPartsOf({ ...base, kind: "kwh2", display_amount_clp: 1, mortgage_parts: null })).toThrow();
  });
});
