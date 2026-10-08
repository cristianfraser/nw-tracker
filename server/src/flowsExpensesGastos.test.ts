import { describe, expect, it } from "vitest";
import type { ExpenseDepositLinkDto } from "./expenseDepositLinks.js";
import { BILLS_CC_EXPENSE_SLUG, REAL_ESTATE_AMORTIZATION_CC_EXPENSE_SLUG } from "./expenseDepositLinks.js";
import { DEPOSITS_CC_EXPENSE_SLUG } from "./ccExpenseCategories.js";
import type { FlowCcExpenseCategoryChartPoint, FlowCcExpenseLineRow } from "./flowsExpenses.js";
import {
  aggregateGastosFromLines,
  buildFlowsExpensesGastosViews,
  expenseYearMonthlyAverages,
  gastosViewKey,
} from "./flowsExpensesGastos.js";

function ccLine(partial: Partial<FlowCcExpenseLineRow>): FlowCcExpenseLineRow {
  const purchaseOn = partial.purchase_on ?? "2025-03-03";
  return {
    source: "cc",
    statement_line_id: 1,
    account_id: 32,
    expense_month: partial.expense_month ?? "2025-04",
    billing_month: partial.billing_month ?? "2025-04",
    purchase_month: partial.purchase_month ?? purchaseOn.slice(0, 7),
    line_role: partial.line_role ?? "installment_cuota",
    occurred_on: "2025-04-24",
    purchase_on: purchaseOn,
    statement_date: "24/04/2024",
    amount_clp: 40_000,
    amount_usd: null,
    amount_usd_at_expense: null,
    merchant: "TEST",
    merchant_key: "TEST",
    installment_flag: 1,
    nro_cuota_current: 1,
    nro_cuota_total: 3,
    category_slug: "unclassified",
    category_unique: false,
    purchase_key: "line-pr:test",
    purchase_notes: "",
    big_group_slug: null,
    origin_label: "4242",
    origin_card_last4: null,
    primary_card_last4: null,
    ...partial,
  };
}

function baseLine(
  overrides: Partial<FlowCcExpenseLineRow> = {}
): FlowCcExpenseLineRow {
  return {
    source: "checking",
    statement_line_id: 1,
    account_id: 10,
    expense_month: "2024-03",
    billing_month: "2024-03",
    purchase_month: "2024-03",
    line_role: "purchase",
    occurred_on: "2024-03-11",
    purchase_on: "2024-03-11",
    statement_date: "",
    amount_clp: 1_000_000,
    amount_usd: null,
    amount_usd_at_expense: null,
    merchant: "Cargo Mercado Capitales",
    merchant_key: "CARGO MERCADO CAPITALES",
    category_slug: DEPOSITS_CC_EXPENSE_SLUG,
    category_unique: true,
    installment_flag: 0,
    nro_cuota_current: null,
    nro_cuota_total: null,
    purchase_key: "checking-cartola:10:2024-03:2024-03-11:1000000:1",
    purchase_notes: "",
    big_group_slug: null,
    origin_label: "Cuenta corriente",
    origin_card_last4: null,
    primary_card_last4: null,
    expense_deposit_links: [
      {
        deposit_movement_id: 99,
        payment_clp: 1_000_000,
        amortization_clp: 600_000,
        carrying_clp: 400_000,
        depto_cuota: "2024-03",
        depto_occurred_on: "2024-03-11",
        link_source: "auto",
      },
    ],
    ...overrides,
  };
}

describe("aggregateGastosFromLines", () => {
  it("a refund counts, negatively, in its category and the month — never as an abono", () => {
    const purchase = ccLine({
      statement_line_id: 1, line_role: "purchase", installment_flag: 0, nro_cuota_current: 0, nro_cuota_total: 0,
      expense_month: "2025-04", billing_month: "2025-04", purchase_on: "2025-04-05", amount_clp: 100_000, category_slug: "fun",
    });
    const refund = ccLine({
      source: "checking", statement_line_id: 2, line_role: "purchase", installment_flag: 0, nro_cuota_current: 0,
      nro_cuota_total: 0, expense_month: "2025-04", billing_month: "2025-04", purchase_on: "2025-04-10",
      amount_clp: -30_000, category_slug: "fun", purchase_key: "checking-mv:2", checking_refund: true,
    });
    const agg = aggregateGastosFromLines([purchase, refund], ["fun"], "split");
    const april = agg.by_month.find((m) => m.period_month === "2025-04")!;
    expect(april.gastos_mes_clp).toBe(70_000);
    expect(april.abonos_mes_clp).toBe(0);
    expect(agg.chart_monthly_by_category.find((p) => p.as_of_date.startsWith("2025-04"))?.fun).toBe(70_000);
  });


  it("split mode sums cuotas in billing months; total mode sums purchase in purchase month", () => {
    const lines = [
      ccLine({
        statement_line_id: 10,
        billing_month: "2025-04",
        expense_month: "2025-04",
        nro_cuota_current: 1,
      }),
      ccLine({
        statement_line_id: 11,
        billing_month: "2025-05",
        expense_month: "2025-05",
        nro_cuota_current: 2,
      }),
      ccLine({
        statement_line_id: 12,
        billing_month: "2025-06",
        expense_month: "2025-06",
        nro_cuota_current: 3,
      }),
      ccLine({
        statement_line_id: -1,
        line_role: "installment_purchase_total",
        expense_month: "2025-03",
        billing_month: "2025-03",
        purchase_month: "2025-03",
        nro_cuota_current: null,
        amount_clp: 120_000,
      }),
    ];

    const split = aggregateGastosFromLines(lines, ["unclassified"], "split");
    expect(split.by_month.find((m) => m.period_month === "2025-03")?.gastos_mes_clp).toBe(0);
    expect(split.by_month.find((m) => m.period_month === "2025-04")?.gastos_mes_clp).toBe(40_000);
    expect(split.by_month.find((m) => m.period_month === "2025-06")?.gastos_mes_clp).toBe(40_000);

    const total = aggregateGastosFromLines(lines, ["unclassified"], "total");
    expect(total.by_month.find((m) => m.period_month === "2025-03")?.gastos_mes_clp).toBe(120_000);
    expect(total.by_month.find((m) => m.period_month === "2025-04")?.gastos_mes_clp).toBe(0);
  });

  it("chart category stacks sum to gasto del mes for each month", () => {
    const lines = [
      ccLine({ statement_line_id: 1, billing_month: "2025-04", amount_clp: 10_000, category_slug: "food" }),
      ccLine({
        statement_line_id: 2,
        billing_month: "2025-04",
        amount_clp: 20_000,
        category_slug: "supermarket",
        merchant: "JUMBO",
        merchant_key: "JUMBO",
      }),
      ccLine({
        source: "checking",
        statement_line_id: 3,
        account_id: 1,
        line_role: "purchase",
        billing_month: "2025-04",
        expense_month: "2025-04",
        amount_clp: 5_000,
        category_slug: "transport",
        installment_flag: 0,
        nro_cuota_current: null,
        nro_cuota_total: null,
      }),
    ];
    const slugs = ["food", "supermarket", "transport"];
    const { by_month, chart_monthly_by_category } = aggregateGastosFromLines(lines, slugs, "split");
    const row = by_month.find((m) => m.period_month === "2025-04");
    expect(row?.gastos_mes_clp).toBe(35_000);
    const point = chart_monthly_by_category.find((p) => p.as_of_date.startsWith("2025-04"));
    const stackSum = slugs.reduce((s, slug) => s + Number(point?.[slug] ?? 0), 0);
    expect(stackSum).toBe(35_000);
  });

  it("excludes big-group lines from chart stacks but not from by_month gastos", () => {
    const lines = [
      ccLine({
        statement_line_id: 1,
        billing_month: "2025-04",
        amount_clp: 10_000,
        category_slug: "food",
        big_group_slug: "vacation",
      }),
      ccLine({
        statement_line_id: 2,
        billing_month: "2025-04",
        amount_clp: 20_000,
        category_slug: "fun",
      }),
    ];
    const slugs = ["food", "fun"];
    const excluded = new Set(["vacation"]);
    const { by_month, chart_monthly_by_category } = aggregateGastosFromLines(
      lines,
      slugs,
      "split",
      excluded
    );
    const row = by_month.find((m) => m.period_month === "2025-04");
    expect(row?.gastos_mes_clp).toBe(30_000);
    const point = chart_monthly_by_category.find((p) => p.as_of_date.startsWith("2025-04"));
    expect(point?.food).toBe(0);
    expect(point?.fun).toBe(20_000);
  });

  it("counts a card-financed mortgage payment's carrying cost once, in either mode", () => {
    // A financed facturado keeps the dividendo in its month for «Total» (total_only) and spreads
    // it over the financing cuotas' months for «Por cuota» (split_only slices, each carrying its
    // share of the mortgage link).
    const mortgageLink = (
      payment: number,
      amortization: number,
      carrying: number
    ): ExpenseDepositLinkDto => ({
      deposit_movement_id: 900,
      payment_clp: payment,
      amortization_clp: amortization,
      carrying_clp: carrying,
      depto_cuota: "30",
      depto_occurred_on: "2026-08-11",
      link_source: "auto",
    });
    const financed = ccLine({
      statement_line_id: 50,
      line_role: "purchase",
      installment_flag: 0,
      nro_cuota_current: null,
      nro_cuota_total: null,
      expense_month: "2026-08",
      billing_month: "2026-08",
      purchase_month: "2026-08",
      amount_clp: 753_333,
      category_slug: "bills",
      gastos_scope: "total_only",
      expense_deposit_links: [mortgageLink(753_333, 410_844, 342_489)],
    });
    const slices = ["2026-09", "2026-10", "2026-11"].map((month, k) =>
      ccLine({
        statement_line_id: -100 - k,
        expense_month: month,
        billing_month: month,
        purchase_month: month,
        nro_cuota_current: k + 1,
        nro_cuota_total: 3,
        amount_clp: 251_111,
        category_slug: "bills",
        gastos_scope: "split_only",
        expense_deposit_links: [mortgageLink(251_111, 136_948, 114_163)],
      })
    );
    const lines = [financed, ...slices];

    for (const mode of ["split", "total"] as const) {
      const agg = aggregateGastosFromLines(lines, ["bills"], mode);
      expect(agg.total).toBe(342_489);
      expect(agg.total_real).toBe(753_333);
      expect(agg.total).toBe(agg.by_month.reduce((sum, m) => sum + m.gastos_mes_clp, 0));
    }
  });
});

describe("aggregateGastosFromLines — linked mortgage deposits", () => {
  it("matches server split for linked mortgage deposits", () => {
    const { by_month, chart_monthly_by_category } = aggregateGastosFromLines(
      [baseLine()],
      [BILLS_CC_EXPENSE_SLUG, REAL_ESTATE_AMORTIZATION_CC_EXPENSE_SLUG]
    );
    expect(by_month[0]?.gastos_mes_clp).toBe(400_000);
    expect(chart_monthly_by_category[0]?.[BILLS_CC_EXPENSE_SLUG]).toBe(400_000);
    expect(chart_monthly_by_category[0]?.[REAL_ESTATE_AMORTIZATION_CC_EXPENSE_SLUG]).toBe(
      -600_000
    );
  });

  it("splits linked CC MetLife mortgage into bills carrying and negative amortization", () => {
    const line = baseLine({
      source: "cc",
      account_id: 32,
      expense_month: "2026-05",
      billing_month: "2026-05",
      purchase_month: "2026-05",
      occurred_on: "2026-05-25",
      purchase_on: "2026-05-11",
      amount_clp: 3_212_395,
      merchant: "METLIFE CHILE SEGUROS",
      merchant_key: "METLIFE CHILE SEGUROS",
      category_slug: BILLS_CC_EXPENSE_SLUG,
      purchase_key: "line-pr:metlife-cuota-27",
      expense_deposit_links: [
        {
          deposit_movement_id: 99,
          payment_clp: 3_212_395,
          amortization_clp: 2_855_638,
          carrying_clp: 356_757,
          depto_cuota: "27",
          depto_occurred_on: "2026-05-11",
          link_source: "auto",
        },
      ],
    });

    const { by_month, chart_monthly_by_category } = aggregateGastosFromLines(
      [line],
      [BILLS_CC_EXPENSE_SLUG, REAL_ESTATE_AMORTIZATION_CC_EXPENSE_SLUG]
    );
    expect(by_month[0]?.gastos_mes_clp).toBe(356_757);
    expect(by_month[0]?.gastos_real_mes_clp).toBe(3_212_395);
    const pt = chart_monthly_by_category[0]!;
    expect(pt[BILLS_CC_EXPENSE_SLUG]).toBe(356_757);
    expect(pt[REAL_ESTATE_AMORTIZATION_CC_EXPENSE_SLUG]).toBe(-2_855_638);
    // Carrying + principal (drawn below the axis) = the payment.
    expect(
      Number(pt[BILLS_CC_EXPENSE_SLUG]) - Number(pt[REAL_ESTATE_AMORTIZATION_CC_EXPENSE_SLUG])
    ).toBe(3_212_395);
  });

  it("converts mortgage carrying to USD by CLP share in USD display", () => {
    // 1.000.000 CLP payment, amount_usd_at_expense 1.000 → implied 1000 CLP/USD.
    const line = baseLine({ amount_usd_at_expense: 1_000 });
    const { by_month, chart_monthly_by_category } = aggregateGastosFromLines(
      [line],
      [BILLS_CC_EXPENSE_SLUG, REAL_ESTATE_AMORTIZATION_CC_EXPENSE_SLUG],
      "split",
      undefined,
      "usd"
    );
    // Carrying 4xx.xxx/1.000.000 of the payment → US$xxx; amortización → −US$600.
    expect(by_month[0]?.gastos_mes_clp).toBe(400);
    expect(chart_monthly_by_category[0]?.[BILLS_CC_EXPENSE_SLUG]).toBe(400);
    expect(chart_monthly_by_category[0]?.[REAL_ESTATE_AMORTIZATION_CC_EXPENSE_SLUG]).toBe(-600);
  });

});

describe("expenseYearMonthlyAverages", () => {
const SLUGS = ["food", "bills"];

function pt(ym: string, food: number, bills = 0): FlowCcExpenseCategoryChartPoint {
  return { as_of_date: `${ym}-28`, food, bills };
}

  it("averages the category total over the year's complete months, current year through last month", () => {
    const points = [
      pt("2025-01", 100, 20),
      pt("2025-12", 300),
      pt("2026-01", 100),
      pt("2026-08", 700),
      pt("2026-09", 9_999), // current month: left out
      pt("2026-11", 5_000), // projected cuota month: left out
    ];
    const avgs = expenseYearMonthlyAverages(points, SLUGS, "2026-09");
    // 2025: 420 over 12 months (the months with no points count as 0).
    expect(avgs["2025"]).toEqual({ from_ym: "2025-01", through_ym: "2025-12", avg: 35 });
    // 2026: 800 over Jan–Aug.
    expect(avgs["2026"]).toEqual({ from_ym: "2026-01", through_ym: "2026-08", avg: 100 });
    expect("2027" in avgs).toBe(false);
  });

  it("starts the first year at its first month with spend", () => {
    const avgs = expenseYearMonthlyAverages([pt("2024-10", 0), pt("2024-11", 300), pt("2024-12", 100)], SLUGS, "2025-03");
    expect(avgs["2024"]).toEqual({ from_ym: "2024-11", through_ym: "2024-12", avg: 200 });
  });

  it("has no current-year entry in January (no complete month yet)", () => {
    const avgs = expenseYearMonthlyAverages([pt("2025-06", 100), pt("2026-01", 500)], SLUGS, "2026-01");
    expect(Object.keys(avgs)).toEqual(["2025"]);
  });
});

describe("buildFlowsExpensesGastosViews", () => {
  const categories = [
    { slug: "bills", parent_slug: null },
    { slug: "taxes", parent_slug: "bills" },
    { slug: "food", parent_slug: null },
    { slug: "deposits", parent_slug: null },
  ];
  const oneShot = (id: number, month: string, amount: number, category: string, bigGroup: string | null = null) =>
    ccLine({
      statement_line_id: id, line_role: "purchase", installment_flag: 0, nro_cuota_current: null, nro_cuota_total: null,
      expense_month: month, billing_month: month, purchase_month: month, purchase_on: `${month}-05`,
      amount_clp: amount, category_slug: category, big_group_slug: bigGroup, purchase_key: `line-pr:${id}`,
    });
  // A 2-cuota plan bought in 2025-11, billing 2025-12 and 2026-01.
  const plan = [
    ccLine({ statement_line_id: 20, billing_month: "2025-12", expense_month: "2025-12", purchase_on: "2025-11-20", nro_cuota_current: 1, nro_cuota_total: 2, amount_clp: 50_000, category_slug: "food" }),
    ccLine({ statement_line_id: 21, billing_month: "2026-01", expense_month: "2026-01", purchase_on: "2025-11-20", nro_cuota_current: 2, nro_cuota_total: 2, amount_clp: 50_000, category_slug: "food" }),
    ccLine({ statement_line_id: -20, line_role: "installment_purchase_total", expense_month: "2025-11", billing_month: "2025-11", purchase_month: "2025-11", nro_cuota_current: null, amount_clp: 100_000, category_slug: "food" }),
  ];
  const lines = [oneShot(1, "2025-10", 10_000, "taxes"), oneShot(2, "2025-11", 20_000, "bills", "trip"), ...plan];

  it("folds subcategories into their parent at the category level only", () => {
    const { views } = buildFlowsExpensesGastosViews(lines, categories, "clp", new Set(), "2026-03");
    const cat = views[gastosViewKey("split", "category")]!;
    const sub = views[gastosViewKey("split", "subcategory")]!;
    expect(cat.chart_category_slugs).toEqual(["bills", "food", "real_estate_amortization"]);
    expect(sub.chart_category_slugs).toEqual(["bills", "taxes", "food", "real_estate_amortization"]);
    const oct = (pts: FlowCcExpenseCategoryChartPoint[]) => pts.find((p) => p.as_of_date.startsWith("2025-10"))!;
    expect(oct(cat.chart_monthly_by_category).bills).toBe(10_000);
    expect(oct(sub.chart_monthly_by_category).taxes).toBe(10_000);
    expect(oct(sub.chart_monthly_by_category).bills).toBe(0);
    expect(cat.total).toBe(sub.total);
  });

  it("ends the table at the mode's last real spend and the chart at Por cuota's, in both modes", () => {
    const { views } = buildFlowsExpensesGastosViews(lines, categories, "clp", new Set(), "2026-03");
    const total = views[gastosViewKey("total", "category")]!;
    expect(total.by_month[0]!.period_month).toBe("2025-11");
    expect(total.chart_monthly_by_category.at(-1)!.as_of_date).toBe("2026-01-31");
    expect(total.by_year.map((r) => [r.period_month, r.gastos_mes_clp])).toEqual([["2025-12", 130_000]]);
  });

  it("leaves excluded big groups out of the chart only, and sends the unfiltered stacks for ordering", () => {
    const plain = buildFlowsExpensesGastosViews(lines, categories, "clp", new Set(), "2026-03");
    expect(plain.views[gastosViewKey("split", "category")]!.chart_sort_monthly_by_category).toBeUndefined();
    const { views } = buildFlowsExpensesGastosViews(lines, categories, "clp", new Set(["trip"]), "2026-03");
    const v = views[gastosViewKey("split", "category")]!;
    const nov = (pts: FlowCcExpenseCategoryChartPoint[]) => pts.find((p) => p.as_of_date.startsWith("2025-11"))!;
    expect(nov(v.chart_monthly_by_category).bills).toBe(0);
    expect(nov(v.chart_sort_monthly_by_category!).bills).toBe(20_000);
    expect(v.by_month.find((r) => r.period_month === "2025-11")!.gastos_mes_clp).toBe(20_000);
  });
});
