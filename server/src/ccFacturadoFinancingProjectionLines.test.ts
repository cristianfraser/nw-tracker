import { describe, expect, it } from "vitest";
import { applyCcFacturadoFinancingProjection } from "./ccFacturadoFinancingProjectionLines.js";
import { aggregateGastosFromLines } from "./flowsCreditCardExpenses.js";
import type { FlowCcExpenseLineRow } from "./flowsCreditCardExpenses.js";
import type { CcFacturadoFinancingLink } from "./ccFacturadoFinancingLinksDb.js";

function ccLine(partial: Partial<FlowCcExpenseLineRow>): FlowCcExpenseLineRow {
  return {
    source: "cc",
    statement_line_id: 1,
    account_id: 100,
    expense_month: "2026-06",
    billing_month: "2026-06",
    purchase_month: "2026-06",
    line_role: "purchase",
    occurred_on: "2026-06-15",
    purchase_on: "2026-06-15",
    statement_date: "15/06/2026",
    amount_clp: 10_000,
    amount_usd: null,
    amount_usd_at_expense: null,
    merchant: "TEST",
    merchant_key: "TEST",
    installment_flag: 0,
    nro_cuota_current: null,
    nro_cuota_total: null,
    category_slug: "unclassified",
    category_unique: false,
    purchase_key: "line-pr:1",
    purchase_notes: "",
    big_group_slug: null,
    origin_label: "Lider",
    origin_card_last4: null,
    primary_card_last4: null,
    ...partial,
  };
}

/** Financing cuota line for a Santander installment purchase. */
function cuota(
  purchaseKey: string,
  billingMonth: string,
  cuotaCurrent: number,
  amount: number
): FlowCcExpenseLineRow {
  return ccLine({
    account_id: 200,
    line_role: "installment_cuota",
    installment_flag: 1,
    nro_cuota_current: cuotaCurrent,
    nro_cuota_total: 3,
    billing_month: billingMonth,
    expense_month: billingMonth,
    purchase_month: "2026-06",
    amount_clp: amount,
    merchant: "EXPRESS PLAZA L",
    merchant_key: "EXPRESS PLAZA L",
    purchase_key: purchaseKey,
    category_slug: "no_cuenta",
    origin_label: "Santander",
  });
}

const MONTHS = ["2026-07", "2026-08", "2026-09"];

/** June Lider facturado (L1 supermarket + L2 restaurants) paid via two 3-cuota Santander purchases. */
function buildScenario(): { lines: FlowCcExpenseLineRow[]; links: CcFacturadoFinancingLink[] } {
  const L1 = 1_200_000;
  const L2 = 1_267_034;
  const lines: FlowCcExpenseLineRow[] = [
    ccLine({ statement_line_id: 11, amount_clp: L1, category_slug: "supermarket", purchase_key: "line-pr:11" }),
    ccLine({ statement_line_id: 12, amount_clp: L2, category_slug: "restaurants", purchase_key: "line-pr:12" }),
  ];
  // Payment A: 3 × 420.000 = 1.260.000 ; Payment B: 3 × 430.000 = 1.290.000 ; T = 2.550.000.
  MONTHS.forEach((m, i) => {
    lines.push(cuota("instA", m, i + 1, 420_000));
    lines.push(cuota("instB", m, i + 1, 430_000));
  });
  const links: CcFacturadoFinancingLink[] = [
    {
      id: 1,
      financed_account_id: 100,
      financed_billing_month: "2026-06",
      financing: [
        { account_id: 200, purchase_key: "instA" },
        { account_id: 200, purchase_key: "instB" },
      ],
    },
  ];
  return { lines, links };
}

const F = 1_200_000 + 1_267_034; // 2.467.034
const T = 3 * 420_000 + 3 * 430_000; // 2.550.000
const GAP = T - F; // 82.966
const CATS = ["supermarket", "restaurants", "bills"];

function monthGastos(rows: { period_month: string; gastos_mes_clp: number }[], m: string): number {
  return rows.find((r) => r.period_month === m)?.gastos_mes_clp ?? 0;
}

describe("ccFacturadoFinancingProjection", () => {
  it("tags financed as total_only and financing as excluded", () => {
    const { lines, links } = buildScenario();
    const out = applyCcFacturadoFinancingProjection(lines, links);
    const financed = out.filter((l) => l.statement_line_id === 11 || l.statement_line_id === 12);
    expect(financed.every((l) => l.gastos_scope === "total_only")).toBe(true);
    const financing = out.filter((l) => l.purchase_key === "instA" || l.purchase_key === "instB");
    expect(financing.length).toBe(6);
    expect(financing.every((l) => l.gastos_scope === "excluded")).toBe(true);
  });

  it("emits split_only projected lines: L_i/n per month + gap bills, summing to T", () => {
    const { lines, links } = buildScenario();
    const out = applyCcFacturadoFinancingProjection(lines, links);
    const projected = out.filter((l) => l.gastos_scope === "split_only");
    // 2 expenses × 3 months + gap × 3 months
    expect(projected.length).toBe(9);
    const byCat = (slug: string) =>
      projected.filter((l) => l.category_slug === slug).reduce((s, l) => s + l.amount_clp, 0);
    // Face value preserved per expense; gap captured as bills.
    expect(byCat("supermarket")).toBe(1_200_000);
    expect(byCat("restaurants")).toBe(1_267_034);
    expect(byCat("bills")).toBe(GAP);
    expect(projected.reduce((s, l) => s + l.amount_clp, 0)).toBe(T);
    // All dated in the cuota months as installment cuotas.
    expect(projected.every((l) => MONTHS.includes(l.billing_month))).toBe(true);
    expect(projected.every((l) => l.line_role === "installment_cuota")).toBe(true);
  });

  it("projected slices anchor category edits to their source line; gap lines have no anchor", () => {
    const { lines, links } = buildScenario();
    lines[1] = ccLine({
      statement_line_id: 12,
      amount_clp: 1_267_034,
      category_slug: "restaurants",
      category_unique: true,
      purchase_key: "line-pr:12",
    });
    const out = applyCcFacturadoFinancingProjection(lines, links);
    const projected = out.filter((l) => l.gastos_scope === "split_only");

    const slicesOf = (sourceLineId: number) =>
      projected.filter((l) => l.category_statement_line_id === sourceLineId);
    expect(slicesOf(11).length).toBe(3);
    expect(slicesOf(11).every((l) => l.category_unique === false)).toBe(true);
    expect(slicesOf(12).length).toBe(3);
    expect(slicesOf(12).every((l) => l.category_unique === true)).toBe(true);

    const gapLines = projected.filter((l) => l.purchase_key.startsWith("financing-proj-gap:"));
    expect(gapLines.length).toBe(3);
    expect(gapLines.every((l) => l.category_statement_line_id == null)).toBe(true);
  });

  it("total mode: facturado in June, financing suppressed", () => {
    const { lines, links } = buildScenario();
    const out = applyCcFacturadoFinancingProjection(lines, links);
    const { by_month } = aggregateGastosFromLines(out, CATS, "total");
    expect(monthGastos(by_month, "2026-06")).toBe(F);
    for (const m of MONTHS) expect(monthGastos(by_month, m)).toBe(0);
  });

  it("cuotas mode: facturado spread across cuota months, June empty, total = T", () => {
    const { lines, links } = buildScenario();
    const out = applyCcFacturadoFinancingProjection(lines, links);
    const { by_month } = aggregateGastosFromLines(out, CATS, "split");
    expect(monthGastos(by_month, "2026-06")).toBe(0);
    const spread = MONTHS.map((m) => monthGastos(by_month, m));
    expect(spread.reduce((s, v) => s + v, 0)).toBe(T);
    // Equal cuotas → each month equals that month's Santander payment (420k+430k = 850k).
    for (const v of spread) expect(v).toBe(850_000);
  });

  it("mortgage line in the facturado keeps its carrying/amortization split across cuotas", () => {
    // June facturado: hipotecario line (1.700.000 = 200.000 carrying + 1.500.000 amortization)
    // + supermarket 767.034. Financed by the same two 3-cuota Santander purchases (T = 2.550.000).
    const MORT = 1_700_000;
    const CARRY = 200_000;
    const AMORT = 1_500_000;
    const SUPER = 767_034;
    const lines: FlowCcExpenseLineRow[] = [
      ccLine({
        statement_line_id: 21,
        amount_clp: MORT,
        category_slug: "bills",
        purchase_key: "line-pr:21",
        merchant: "RECAUDACION HIPOTECARIO",
        expense_deposit_links: [
          {
            deposit_movement_id: 1,
            payment_clp: MORT,
            amortization_clp: AMORT,
            carrying_clp: CARRY,
            depto_cuota: "2026-06",
            depto_occurred_on: "2026-06-05",
            link_source: "manual",
          },
        ],
      }),
      ccLine({ statement_line_id: 22, amount_clp: SUPER, category_slug: "supermarket", purchase_key: "line-pr:22" }),
    ];
    MONTHS.forEach((m, i) => {
      lines.push(cuota("instA", m, i + 1, 420_000));
      lines.push(cuota("instB", m, i + 1, 430_000));
    });
    const links: CcFacturadoFinancingLink[] = [
      {
        id: 7,
        financed_account_id: 100,
        financed_billing_month: "2026-06",
        financing: [
          { account_id: 200, purchase_key: "instA" },
          { account_id: 200, purchase_key: "instB" },
        ],
      },
    ];

    const out = applyCcFacturadoFinancingProjection(lines, links);
    const projected = out.filter((l) => l.gastos_scope === "split_only");
    const mortgageProj = projected.filter((l) => l.expense_deposit_links != null);
    expect(mortgageProj.length).toBe(3);
    const sum = (arr: number[]) => arr.reduce((s, v) => s + v, 0);
    expect(sum(mortgageProj.map((l) => l.expense_deposit_links![0]!.carrying_clp))).toBe(CARRY);
    expect(sum(mortgageProj.map((l) => l.expense_deposit_links![0]!.amortization_clp))).toBe(AMORT);

    // Cuotas mode: gastos = carrying + gap + supermarket (amortization principal is offset out).
    const gapCuotas = 3 * 420_000 + 3 * 430_000 - (MORT + SUPER);
    const split = aggregateGastosFromLines(out, CATS, "split");
    const splitTotal = MONTHS.reduce((s, m) => s + monthGastos(split.by_month, m), 0);
    expect(splitTotal).toBe(CARRY + gapCuotas + SUPER);

    // Total mode: June gastos = carrying + supermarket (mortgage line's own split; no gap).
    const total = aggregateGastosFromLines(out, CATS, "total");
    expect(monthGastos(total.by_month, "2026-06")).toBe(CARRY + SUPER);
  });

  it("no links → lines unchanged", () => {
    const { lines } = buildScenario();
    const out = applyCcFacturadoFinancingProjection(lines, []);
    expect(out.length).toBe(lines.length);
    expect(out.some((l) => l.gastos_scope === "split_only")).toBe(false);
    expect(out.every((l) => l.gastos_scope == null)).toBe(true);
  });
});
