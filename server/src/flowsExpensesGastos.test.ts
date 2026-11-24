import { cardLineKind } from "nw-tracker-contracts";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ExpenseDepositLinkDto } from "./expenseDepositLinks.js";
import { BILLS_CC_EXPENSE_SLUG, REAL_ESTATE_AMORTIZATION_CC_EXPENSE_SLUG } from "./expenseDepositLinks.js";
import { DEPOSITS_CC_EXPENSE_SLUG } from "./ccExpenseCategories.js";
import { markCardRefunds, markFinancingCostLines, type FlowCcExpenseLineRow } from "./flowsExpenses.js";
import { enrichLinesWithNotaDeCreditoPairing } from "./ccNotaDeCreditoPairing.js";
import {
  aggregateGastosFromLines as aggregateFinishedLines,
  bigGroupUsageByMode as bigGroupUsageOfFinishedLines,
  countsTowardGastosMes,
  gastosMonthRows as gastosMonthRowsOfFinishedLines,
} from "./flowsExpensesGastos.js";
import { withLineMoney } from "./lineMoney.js";

// The gastos views read finished lines: the fixtures go through the «line money» step first.
const aggregateGastosFromLines = (
  lines: FlowCcExpenseLineRow[],
  ...rest: Parameters<typeof aggregateFinishedLines> extends [unknown, ...infer R] ? R : never
) => aggregateFinishedLines(withLineMoney(lines), ...rest);
const gastosMonthRows = (
  lines: FlowCcExpenseLineRow[],
  ...rest: Parameters<typeof gastosMonthRowsOfFinishedLines> extends [unknown, ...infer R] ? R : never
) => gastosMonthRowsOfFinishedLines(withLineMoney(lines), ...rest);
const bigGroupUsageByMode = (
  lines: FlowCcExpenseLineRow[],
  ...rest: Parameters<typeof bigGroupUsageOfFinishedLines> extends [unknown, ...infer R] ? R : never
) => bigGroupUsageOfFinishedLines(withLineMoney(lines), ...rest);

/** A card line as the builder emits it: with the kind the importer stored for its statement line. */
function withStoredKind<L extends FlowCcExpenseLineRow>(l: L): L {
  if (l.source !== "cc") return l;
  const dollars = l.amount_usd != null;
  return {
    ...l,
    cc_line_kind: cardLineKind({
      installment_flag: l.installment_flag,
      merchant: l.merchant,
      amount_clp: dollars ? null : l.amount_clp,
      amount_usd: l.amount_usd,
      statement_currency: dollars ? "usd" : "clp",
    }),
  };
}

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
    origin: { kind: "card", account_name: null, card_last4: null, additional: false },
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
    origin: { kind: "card", account_name: null, card_last4: null, additional: false },
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
    expect(april.gastos_mes).toBe(70_000);
    expect(april.abonos_mes).toBe(0);
    expect(agg.chart_monthly_by_category.find((p) => p.as_of_date.startsWith("2025-04"))?.fun).toBe(70_000);
  });


  it("a card credit no purchase annuls counts negatively in its category; payments and paired notas do not", () => {
    const one = { line_role: "purchase" as const, installment_flag: 0, nro_cuota_current: 0, nro_cuota_total: 0, expense_month: "2025-04", billing_month: "2025-04" };
    const drafts = [
      ccLine({ ...one, statement_line_id: 1, purchase_on: "2025-04-05", amount_clp: 100_000, category_slug: "supermarket", merchant: "LIDER" }),
      ccLine({ ...one, statement_line_id: 2, purchase_on: "2025-04-12", amount_clp: -37_500, category_slug: "supermarket", merchant: "GLASS LIDER.CL (T)" }),
      ccLine({ ...one, statement_line_id: 3, purchase_on: "2025-04-20", amount_clp: -500_000, category_slug: "unclassified", merchant: "PAGO" }),
      ccLine({ ...one, statement_line_id: 4, purchase_on: "2025-04-21", amount_clp: -60_000, category_slug: "no_cuenta", merchant: "ABONO DE DIVISAS" }),
      ccLine({ ...one, statement_line_id: 5, purchase_on: "2025-04-22", amount_clp: 45_000, category_slug: "fun", merchant: "CINE" }),
      ccLine({ ...one, statement_line_id: 6, purchase_on: "2025-04-23", amount_clp: -45_000, category_slug: "fun", merchant: "NOTA DE CREDITO" }),
      ccLine({ ...one, statement_line_id: 7, purchase_on: "2025-04-24", amount_clp: -2_000, category_slug: "fun", merchant: "NOTA DE CREDITO" }),
      ccLine({ ...one, statement_line_id: 8, purchase_on: "2025-04-25", amount_clp: -70_000, category_slug: "unclassified", merchant: "TRASPASO DE DEUDA INTERNACIO" }),
    ];
    const lines = markCardRefunds(enrichLinesWithNotaDeCreditoPairing(drafts.map(withStoredKind))) as FlowCcExpenseLineRow[];
    expect(lines.filter((l) => l.card_refund).map((l) => l.statement_line_id)).toEqual([2, 7]);
    const agg = aggregateGastosFromLines(lines, ["supermarket", "fun"], "split");
    const april = agg.by_month.find((m) => m.period_month === "2025-04")!;
    // 100.000 − 37.500 (refund) − 2.000 (small unmatched nota); the cine and its nota net out.
    expect(april.gastos_mes).toBe(100_000 - 37_500 - 2_000);
    expect(april.abonos_mes).toBe(-500_000 - 60_000 - 70_000);
    const stack = agg.chart_monthly_by_category.find((p) => p.as_of_date.startsWith("2025-04"))!;
    expect(stack.supermarket).toBe(62_500);
    expect(stack.fun).toBe(-2_000);
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
    expect(split.by_month.find((m) => m.period_month === "2025-03")?.gastos_mes).toBe(0);
    expect(split.by_month.find((m) => m.period_month === "2025-04")?.gastos_mes).toBe(40_000);
    expect(split.by_month.find((m) => m.period_month === "2025-06")?.gastos_mes).toBe(40_000);

    const total = aggregateGastosFromLines(lines, ["unclassified"], "total");
    expect(total.by_month.find((m) => m.period_month === "2025-03")?.gastos_mes).toBe(120_000);
    expect(total.by_month.find((m) => m.period_month === "2025-04")?.gastos_mes).toBe(0);
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
    expect(row?.gastos_mes).toBe(35_000);
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
    expect(row?.gastos_mes).toBe(30_000);
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
      expect(agg.total).toBe(agg.by_month.reduce((sum, m) => sum + m.gastos_mes, 0));
    }
  });
});

describe("aggregateGastosFromLines — linked mortgage deposits", () => {
  it("matches server split for linked mortgage deposits", () => {
    const { by_month, chart_monthly_by_category } = aggregateGastosFromLines(
      [baseLine()],
      [BILLS_CC_EXPENSE_SLUG, REAL_ESTATE_AMORTIZATION_CC_EXPENSE_SLUG]
    );
    expect(by_month[0]?.gastos_mes).toBe(400_000);
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
    expect(by_month[0]?.gastos_mes).toBe(356_757);
    expect(by_month[0]?.gastos_real_mes).toBe(3_212_395);
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
    expect(by_month[0]?.gastos_mes).toBe(400);
    expect(chart_monthly_by_category[0]?.[BILLS_CC_EXPENSE_SLUG]).toBe(400);
    expect(chart_monthly_by_category[0]?.[REAL_ESTATE_AMORTIZATION_CC_EXPENSE_SLUG]).toBe(-600);
  });

});

describe("gastosMonthRows", () => {
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

  it("ends at the mode's last real spend: «Total» drops the months only cuotas fill", () => {
    expect(gastosMonthRows(lines, "total", "clp").map((r) => [r.period_month, r.gastos_mes])).toEqual([
      ["2025-11", 120_000],
      ["2025-10", 10_000],
    ]);
    expect(gastosMonthRows(lines, "split", "clp").map((r) => r.period_month)).toEqual(["2026-01", "2025-12", "2025-11", "2025-10"]);
  });
});

type GastosMesCase = {
  note: string;
  line: Partial<FlowCcExpenseLineRow>;
  split: boolean;
  total: boolean;
};

const gastosMesCases = JSON.parse(
  fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "test", "gastosMesCountingCases.json"),
    "utf-8"
  )
) as GastosMesCase[];

/** The gastos counting rule, case by case (`gastosMesCountingCases.json`). */
describe("countsTowardGastosMes (shared case table)", () => {
  it.each(gastosMesCases)("$note", (c) => {
    const line = ccLine({
      line_role: "purchase",
      installment_flag: 0,
      nro_cuota_current: null,
      nro_cuota_total: null,
      amount_clp: 10_000,
      category_slug: "supermarket",
      ...c.line,
    });
    expect(countsTowardGastosMes(line, "split")).toBe(c.split);
    expect(countsTowardGastosMes(line, "total")).toBe(c.total);
  });
});

describe("bigGroupUsageByMode", () => {
  it("sums the lines that count in each mode, counts purchases once, sorts by label", () => {
    const purchase = (over: Partial<FlowCcExpenseLineRow>) =>
      ccLine({ line_role: "purchase", installment_flag: 0, nro_cuota_current: null, category_slug: "travel", ...over });
    const lines = [
      purchase({ purchase_key: "a", amount_clp: 1000.4, big_group_slug: "trip" }),
      purchase({ purchase_key: "a", amount_clp: 500, big_group_slug: "trip" }),
      purchase({ purchase_key: "b", amount_clp: 700, big_group_slug: "trip", category_slug: "no_cuenta" }),
      ccLine({ purchase_key: "c", amount_clp: 300, big_group_slug: "boda" }),
      ccLine({ purchase_key: "c", line_role: "installment_purchase_total", installment_flag: 1, amount_clp: 900, big_group_slug: "boda" }),
      purchase({ purchase_key: "d", amount_clp: 50 }),
    ];
    const usage = bigGroupUsageByMode(lines, [
      { slug: "trip", label: "Viaje" },
      { slug: "boda", label: "Boda" },
    ], "clp");
    expect(usage.split).toEqual([
      { slug: "boda", label: "Boda", total: 300, purchase_count: 1 },
      { slug: "trip", label: "Viaje", total: 1500, purchase_count: 1 },
    ]);
    expect(usage.total).toEqual([
      { slug: "boda", label: "Boda", total: 900, purchase_count: 1 },
      { slug: "trip", label: "Viaje", total: 1500, purchase_count: 1 },
    ]);
  });
});

describe("markFinancingCostLines", () => {
  const charge = (over: Partial<FlowCcExpenseLineRow>) =>
    withStoredKind(ccLine({ line_role: "purchase", installment_flag: 0, nro_cuota_current: null, amount_clp: 2_990, ...over }));

  it("stamps the bank's section-3 charges the card P/L counts, by the shared statement-line rules", () => {
    const [admin, ite, interest, usdFee, purchase, payment, traspaso, cuota, checking] = markFinancingCostLines([
      charge({ merchant: "Servicio Administracion" }),
      charge({ merchant: "Impuesto ITE" }),
      charge({ merchant: "INTERESES ROTATIVOS" }),
      charge({ merchant: "COMISION USO INTERNACIONAL", amount_usd: 3.5 }),
      charge({ merchant: "SUPERMERCADO" }),
      charge({ merchant: "MONTO CANCELADO", amount_usd: 12 }),
      charge({ merchant: "TRASPASO A DEUDA NACIONAL" }),
      charge({ merchant: "INTERESES", installment_flag: 1 }),
      charge({ source: "checking", merchant: "COMISION MANTENCION" }),
    ]);
    expect(admin!.is_financing_cost).toBe(true);
    expect(ite!.is_financing_cost).toBe(true);
    expect(interest!.is_financing_cost).toBe(true);
    expect(usdFee!.is_financing_cost).toBe(true);
    expect(purchase!.is_financing_cost).toBeUndefined();
    expect(payment!.is_financing_cost).toBeUndefined();
    expect(traspaso!.is_financing_cost).toBeUndefined();
    expect(cuota!.is_financing_cost).toBeUndefined();
    expect(checking!.is_financing_cost).toBeUndefined();
  });

  it("reads the stored kind and drops it from the line", () => {
    const [line] = markFinancingCostLines([{ ...ccLine({ merchant: "SUPERMERCADO" }), cc_line_kind: "financing_charge" }]);
    expect(line!.is_financing_cost).toBe(true);
    expect("cc_line_kind" in line!).toBe(false);
  });

  it("never stamps a credit", () => {
    expect(markFinancingCostLines([charge({ merchant: "COMISION", amount_clp: -100 })])[0]!.is_financing_cost).toBeUndefined();
  });
});
