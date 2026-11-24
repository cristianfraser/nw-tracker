import { describe, expect, it } from "vitest";
import type { FlowCcExpenseLineRow } from "./flowsExpenses.js";
import {
  buildExpensesSpentPayload,
  heatLevels,
  selectSpentLines,
  spentDayOfLine,
  type SpentOptions,
} from "./flowsExpensesSpent.js";
import { withLineMoney } from "./lineMoney.js";

const TODAY = "2026-03-10";

function line(partial: Partial<FlowCcExpenseLineRow>): FlowCcExpenseLineRow {
  const purchaseOn = partial.purchase_on ?? "2026-03-02";
  return {
    source: "cc",
    statement_line_id: 1,
    account_id: 32,
    expense_month: partial.expense_month ?? "2026-04",
    billing_month: partial.billing_month ?? "2026-04",
    purchase_month: purchaseOn.slice(0, 7),
    line_role: "purchase",
    occurred_on: "2026-03-25",
    purchase_on: purchaseOn,
    statement_date: "25/03/2026",
    amount_clp: 10_000,
    amount_usd: null,
    amount_usd_at_expense: null,
    merchant: "SPENT TEST",
    merchant_key: "SPENT TEST",
    installment_flag: 0,
    nro_cuota_current: 0,
    nro_cuota_total: 0,
    category_slug: "supermarket",
    category_unique: false,
    purchase_key: "line-pr:spent-test",
    purchase_notes: "",
    big_group_slug: null,
    origin_label: "4242",
    origin: { kind: "card", account_name: null, card_last4: null, additional: false },
    origin_card_last4: null,
    primary_card_last4: null,
    ...partial,
  };
}

const CATEGORIES = [
  { slug: "unclassified", parent_slug: null },
  { slug: "bills", parent_slug: null },
  { slug: "taxes", parent_slug: "bills" },
  { slug: "supermarket", parent_slug: null },
  { slug: "food", parent_slug: null },
];

const OPTS: SpentOptions = {
  unit: "clp",
  mode: "split",
  level: "category",
  excludedBigGroups: new Set(),
  includePreTax: false,
};

describe("spentDayOfLine", () => {
  it("puts a purchase on its purchase day, whatever month it was billed in", () => {
    expect(spentDayOfLine(line({ purchase_on: "2026-02-27", billing_month: "2026-03" }), "split")).toBe("2026-02-27");
  });

  it("puts a cuota on its statement day in «split» and nowhere in «total»", () => {
    const cuota = line({ line_role: "installment_cuota", installment_flag: 1, nro_cuota_current: 2, nro_cuota_total: 3, occurred_on: "2026-03-25" });
    expect(spentDayOfLine(cuota, "split")).toBe("2026-03-25");
    expect(spentDayOfLine(cuota, "total")).toBeNull();
  });

  it("puts a whole installment purchase on its purchase day in «total» only", () => {
    const whole = line({ line_role: "installment_purchase_total", purchase_on: "2026-01-15" });
    expect(spentDayOfLine(whole, "total")).toBe("2026-01-15");
    expect(spentDayOfLine(whole, "split")).toBeNull();
  });

  it("leaves out an annulled purchase", () => {
    expect(spentDayOfLine(line({ nota_credito_role: "annulled_purchase" }), "split")).toBeNull();
  });
});

describe("heatLevels", () => {
  it("is 0 for days without spend and quartiles for the rest", () => {
    expect(heatLevels([0, 10, 20, 30, 40, -5])).toEqual([0, 1, 2, 3, 4, 0]);
  });
});

describe("buildExpensesSpentPayload", () => {
  const lines = withLineMoney([
    line({ statement_line_id: 1, purchase_on: "2026-02-27", amount_clp: 30_000 }),
    line({ statement_line_id: 2, purchase_on: "2026-03-02", amount_clp: 10_000 }),
    line({ statement_line_id: 3, purchase_on: "2026-03-05", amount_clp: 5_000, category_slug: "taxes" }),
    // A trip excluded from the chart: only «total real» keeps it.
    line({ statement_line_id: 4, purchase_on: "2026-03-05", amount_clp: 50_000, big_group_slug: "trip", purchase_key: "line-pr:trip" }),
    // After today: not spent yet.
    line({ statement_line_id: 5, purchase_on: "2026-03-20", amount_clp: 99_000 }),
  ]);
  const payload = buildExpensesSpentPayload(
    lines,
    CATEGORIES,
    { ...OPTS, excludedBigGroups: new Set(["trip"]) },
    "90d",
    TODAY
  );
  const at = (day: string) => payload.chart.find((d) => d.day === day)!;

  it("runs the month to date and resets on the 1st", () => {
    expect(at("2026-02-28").total).toBe(30_000);
    expect(at("2026-03-01").total).toBe(0);
    expect(at("2026-03-02").total).toBe(10_000);
    expect(at("2026-03-10").total).toBe(15_000);
    expect(payload.chart.at(-1)!.day).toBe(TODAY);
  });

  it("stacks by category at the level (a subcategory folds into its parent)", () => {
    const bills = payload.category_slugs.indexOf("bills");
    const supermarket = payload.category_slugs.indexOf("supermarket");
    expect(at("2026-03-10").stacks[bills]).toBe(5_000);
    expect(at("2026-03-10").stacks[supermarket]).toBe(10_000);
    expect(payload.category_slugs).not.toContain("food");
  });

  it("counts months by spending day, the excluded big group only in total real", () => {
    const march = payload.months.find((m) => m.month === "2026-03")!;
    const feb = payload.months.find((m) => m.month === "2026-02")!;
    expect(feb.total).toBe(30_000);
    expect(march.total).toBe(15_000);
    expect(march.total_real).toBe(65_000);
    expect(march.line_count).toBe(2);
    expect(payload.months.at(-1)!.month).toBe("2026-03");
    expect(march.days.at(-1)!.day).toBe(TODAY);
  });

  it("scales the matrix bars on one scale and the month bars on another", () => {
    const supermarket = payload.category_slugs.indexOf("supermarket");
    const feb = payload.months.find((m) => m.month === "2026-02")!;
    const march = payload.months.find((m) => m.month === "2026-03")!;
    expect(feb.cells[supermarket]).toEqual({ value: 30_000, bar: 1 });
    expect(march.cells[supermarket]!.bar).toBeCloseTo(10_000 / 30_000, 3);
    expect(feb.total_bar).toBe(1);
    expect(march.total_bar).toBe(0.5);
  });
});

describe("the chart's first month", () => {
  it("keeps a category spent only before the range's first day (the month runs from its 1st)", () => {
    // 90 days back from 2026-03-10 is 2025-12-11: December runs from the 1st.
    const lines = withLineMoney([
      line({ statement_line_id: 1, purchase_on: "2025-12-03", amount_clp: 8_000, category_slug: "food" }),
    ]);
    const payload = buildExpensesSpentPayload(lines, CATEGORIES, OPTS, "90d", TODAY);
    const first = payload.chart[0]!;
    expect(first.day).toBe("2025-12-11");
    expect(payload.category_slugs).toContain("food");
    expect(first.stacks[payload.category_slugs.indexOf("food")]).toBe(8_000);
    expect(first.total).toBe(8_000);
  });
});

describe("pre-tax deductions", () => {
  it("track spending from net pay: payslip deductions only when asked", () => {
    const lines = withLineMoney([
      line({ statement_line_id: 1, purchase_on: "2026-03-02", amount_clp: 10_000, category_slug: "bills" }),
      line({ source: "payslip", pre_tax: true, statement_line_id: 7001, account_id: 0, purchase_on: "2026-03-05", amount_clp: 4_000, category_slug: "taxes", purchase_key: "payslip:7001" }),
    ]);
    const march = (includePreTax: boolean) =>
      buildExpensesSpentPayload(lines, CATEGORIES, { ...OPTS, includePreTax }, "90d", TODAY).months.find((m) => m.month === "2026-03")!.total;
    expect(march(false)).toBe(10_000);
    expect(march(true)).toBe(14_000);
  });
});

describe("year averages", () => {
  it("average each year's complete months from the first month with spend, leaving the current month out", () => {
    const lines = withLineMoney([
      line({ statement_line_id: 1, purchase_on: "2025-11-10", amount_clp: 20_000 }),
      // December 2025 spends nothing but counts as a month.
      line({ statement_line_id: 2, purchase_on: "2026-01-05", amount_clp: 30_000 }),
      line({ statement_line_id: 3, purchase_on: "2026-02-05", amount_clp: 10_000 }),
      // The current month (March) is not complete.
      line({ statement_line_id: 4, purchase_on: "2026-03-02", amount_clp: 99_000 }),
    ]);
    const payload = buildExpensesSpentPayload(lines, CATEGORIES, OPTS, "total", TODAY);
    expect(payload.year_averages).toEqual([
      { year: "2025", from_ym: "2025-11", through_ym: "2025-12", avg: 10_000 },
      { year: "2026", from_ym: "2026-01", through_ym: "2026-02", avg: 20_000 },
    ]);
  });
});

describe("selectSpentLines", () => {
  const lines = withLineMoney([
    line({ statement_line_id: 1, purchase_on: "2026-03-02", amount_clp: 10_000 }),
    line({ statement_line_id: 2, purchase_on: "2026-03-05", amount_clp: 5_000, category_slug: "taxes" }),
    line({ statement_line_id: 3, purchase_on: "2026-03-05", amount_clp: 2_000 }),
    line({ statement_line_id: 4, purchase_on: "2026-02-20", amount_clp: 7_000 }),
  ]);

  it("lists a month newest day first with day totals", () => {
    const picked = selectSpentLines(lines, CATEGORIES, OPTS, { month: "2026-03", day: null, category: null }, TODAY);
    expect(picked.total).toBe(17_000);
    expect(picked.days.map((d) => [d.day, d.total, d.lines.length])).toEqual([
      ["2026-03-05", 7_000, 2],
      ["2026-03-02", 10_000, 1],
    ]);
  });

  it("narrows to a day and to a category at the level, keeping each line's own category", () => {
    const picked = selectSpentLines(lines, CATEGORIES, OPTS, { month: "2026-03", day: "2026-03-05", category: "bills" }, TODAY);
    expect(picked.total).toBe(5_000);
    expect(picked.days[0]!.lines.map((l) => l.category_slug)).toEqual(["taxes"]);
  });

  it("refuses a day outside the month", () => {
    expect(() =>
      selectSpentLines(lines, CATEGORIES, OPTS, { month: "2026-03", day: "2026-02-05", category: null }, TODAY)
    ).toThrow(/not in month/);
  });
});

describe("a mortgage payment paid by card", () => {
  it("counts its carrying in bills and leaves its amortization out of the month-to-date views", () => {
    const lines = withLineMoney([
      line({
        statement_line_id: 9,
        purchase_on: "2026-03-04",
        amount_clp: 750_000,
        category_slug: "bills",
        expense_deposit_links: [
          {
            deposit_movement_id: 900,
            payment_clp: 750_000,
            amortization_clp: 410_000,
            carrying_clp: 340_000,
            depto_cuota: "30",
            depto_occurred_on: "2026-03-04",
            link_source: "auto",
          },
        ],
      }),
    ]);
    const categories = [...CATEGORIES, { slug: "real_estate_amortization", parent_slug: null }];
    const payload = buildExpensesSpentPayload(lines, categories, OPTS, "90d", TODAY);
    const march = payload.months.find((m) => m.month === "2026-03")!;
    expect(march.total).toBe(340_000);
    expect(march.total_real).toBe(750_000);
    expect(payload.category_slugs).not.toContain("real_estate_amortization");
    expect(payload.chart.at(-1)!.stacks[payload.category_slugs.indexOf("bills")]).toBe(340_000);
  });

  it("lists the payment under «bills» with its carrying, whatever the line's own category", () => {
    const lines = withLineMoney([
      line({
        statement_line_id: 9,
        purchase_on: "2026-03-04",
        amount_clp: 750_000,
        category_slug: "deposits",
        expense_deposit_links: [
          {
            deposit_movement_id: 900,
            payment_clp: 750_000,
            amortization_clp: 410_000,
            carrying_clp: 340_000,
            depto_cuota: "30",
            depto_occurred_on: "2026-03-04",
            link_source: "auto",
          },
        ],
      }),
    ]);
    const categories = [...CATEGORIES, { slug: "deposits", parent_slug: null }, { slug: "real_estate_amortization", parent_slug: null }];
    const payload = buildExpensesSpentPayload(lines, categories, OPTS, "90d", TODAY);
    const cell = payload.months.find((m) => m.month === "2026-03")!.cells[payload.category_slugs.indexOf("bills")]!.value;
    const picked = selectSpentLines(lines, categories, OPTS, { month: "2026-03", day: null, category: "bills" }, TODAY);
    expect(picked.total).toBe(cell);
    expect(picked.days[0]!.lines.map((l) => l.statement_line_id)).toEqual([9]);
  });
});
