import { describe, expect, it } from "vitest";
import type { FlowCcExpenseLineRow } from "nw-tracker-contracts/dto/flows";
import { withExpenseLineShapes } from "./expenseLineShapes.js";
import { countsTowardGastosMes, isGastosRefundLine } from "./flowsExpensesGastos.js";
import { isCcExpenseTotalsExcludedSlug, isInstallmentCuotaZeroLine } from "./ccExpenseCategories.js";

const RULES = { countsTowardGastosMes, isGastosRefundLine, isCcExpenseTotalsExcludedSlug, isInstallmentCuotaZeroLine };

function line(partial: Partial<FlowCcExpenseLineRow>): FlowCcExpenseLineRow {
  return {
    source: "cc",
    statement_line_id: 1,
    account_id: 32,
    expense_month: "2025-05",
    billing_month: "2025-05",
    purchase_month: "2025-05",
    line_role: "purchase",
    amount_clp: 10_000,
    installment_flag: 0,
    nro_cuota_current: null,
    nro_cuota_total: null,
    category_slug: "supermarket",
    category_unique: false,
    merchant: "TEST",
    merchant_key: "TEST",
    occurred_on: "2025-05-10",
    purchase_on: null,
    statement_date: "22/05/2025",
    purchase_key: "line-pr:test",
    purchase_notes: "",
    big_group_slug: null,
    origin_label: "4242",
    origin: { kind: "card", account_name: null, card_last4: null, additional: false },
    amount_usd: null,
    amount_usd_at_expense: null,
    origin_card_last4: null,
    primary_card_last4: null,
    ...partial,
  };
}

const shape = (partial: Partial<FlowCcExpenseLineRow>) => withExpenseLineShapes([line(partial)], RULES)[0]!;
const cuota = (partial: Partial<FlowCcExpenseLineRow>) =>
  shape({ line_role: "installment_cuota", installment_flag: 1, nro_cuota_current: 1, nro_cuota_total: 3, ...partial });

describe("expense line shapes: month and modal sections", () => {
  it("a plan's total is shown in its purchase month, a cuota in its billing month", () => {
    expect(shape({ line_role: "installment_purchase_total", purchase_month: "2025-03" }).period_month).toBe("2025-03");
    expect(cuota({ billing_month: "2025-06", expense_month: "2025-05" }).period_month).toBe("2025-06");
    expect(shape({ expense_month: "2025-02" }).period_month).toBe("2025-02");
  });

  it("a billed cuota lists under Cuotas per cuota, nowhere in Total", () => {
    expect(cuota({}).month_modal_sections).toEqual({ split: ["installments"], total: [] });
  });

  it("a no_cuenta cuota and a cuota 0 list under Excluded", () => {
    expect(cuota({ category_slug: "no_cuenta" }).month_modal_sections).toEqual({ split: ["excluded"], total: ["excluded"] });
    expect(cuota({ nro_cuota_current: 0 }).month_modal_sections).toEqual({ split: ["excluded"], total: ["excluded"] });
  });

  it("a plan's total lists under Compras in Total and under Excluded per cuota", () => {
    const total = shape({ line_role: "installment_purchase_total", installment_flag: 1, nro_cuota_total: 3 });
    expect(total.month_modal_sections).toEqual({ split: ["excluded"], total: ["purchases"] });
  });

  it("an annulled plan's total lists under Compras and Excluded in Total", () => {
    const total = shape({ line_role: "installment_purchase_total", nota_credito_role: "annulled_purchase" });
    expect(total.month_modal_sections?.total).toEqual(["purchases", "excluded"]);
  });

  it("purchases in an excluded category list under Excluded, not Compras", () => {
    expect(shape({ category_slug: "deposits" }).month_modal_sections).toEqual({ split: ["excluded"], total: ["excluded"] });
  });

  it("a credit that is no refund is an abono; a small unmatched nota is neither", () => {
    const credit = shape({ amount_clp: -43_691, merchant: "NOTA DE CREDITO" });
    expect(credit.abono).toBe(true);
    expect(credit.month_modal_sections).toEqual({ split: ["abonos"], total: ["abonos"] });
    const nota = shape({ amount_clp: -9_999, nota_credito_role: "unmatched_nota" });
    expect(nota.abono).toBe(false);
    expect(nota.month_modal_sections).toEqual({ split: [], total: [] });
  });

  it("a refund counts in Compras with its negative amount", () => {
    const refund = shape({ amount_clp: -500, card_refund: true });
    expect(refund.counts_toward_gastos).toEqual({ split: true, total: true });
    expect(refund.month_modal_sections).toEqual({ split: ["purchases"], total: ["purchases"] });
  });

  it("a nota-annulled purchase is excluded and never pending classification", () => {
    const annulled = shape({ category_slug: "unclassified", nota_credito_role: "annulled_purchase" });
    expect(annulled.month_modal_sections).toEqual({ split: ["excluded"], total: ["excluded"] });
    expect(annulled.pending_classification).toBe(false);
    expect(shape({ category_slug: "unclassified" }).pending_classification).toBe(true);
  });
});

describe("expense line shapes: row capabilities", () => {
  it("only a card-feed or pasted line can be deleted", () => {
    expect(shape({ web_paste: true }).can_delete).toBe(true);
    expect(shape({}).can_delete).toBe(false);
    expect(shape({ source: "checking", web_paste: true }).can_delete).toBe(false);
  });

  it("a plain one-shot card purchase can become a plan; a cuota, a piece or a nota cannot", () => {
    expect(shape({}).can_make_installment).toBe(true);
    expect(cuota({}).can_make_installment).toBe(false);
    expect(shape({ piece_seq: 1 }).can_make_installment).toBe(false);
    expect(shape({ nota_credito_role: "annulled_purchase" }).can_make_installment).toBe(false);
    expect(shape({ source: "checking" }).can_make_installment).toBe(false);
  });

  it("a manual plan's line can be edited; a statement plan's cannot", () => {
    expect(cuota({ statement_line_id: -5, installment_purchase_id: 5, installment_source: "manual" }).can_edit_installment).toBe(true);
    expect(cuota({ statement_line_id: -5, installment_purchase_id: 5, installment_source: "statement" }).can_edit_installment).toBe(false);
  });

  it("pieces: card and checking purchases with an amount, never installments or refunds", () => {
    expect(shape({}).can_edit_pieces).toBe(true);
    expect(shape({ source: "checking" }).can_edit_pieces).toBe(true);
    expect(cuota({}).can_edit_pieces).toBe(false);
    expect(shape({ source: "checking", amount_clp: -500, checking_refund: true }).can_edit_pieces).toBe(false);
    expect(shape({ source: "manual" }).can_edit_pieces).toBe(false);
  });
});
