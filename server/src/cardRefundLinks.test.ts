import { describe, expect, it } from "vitest";
import type { FlowCcExpenseLineRow } from "./flowsExpenses.js";
import { cardRefundCandidates, isLinkableCardRefund, refundPurchaseIndex, withCardRefundLinks } from "./cardRefundLinks.js";
import { withLineMoney } from "./lineMoney.js";

function line(partial: Partial<FlowCcExpenseLineRow>): FlowCcExpenseLineRow {
  const purchaseOn = partial.purchase_on ?? "2026-05-10";
  return {
    source: "cc",
    statement_line_id: 1,
    account_id: 42,
    expense_month: purchaseOn.slice(0, 7),
    billing_month: purchaseOn.slice(0, 7),
    purchase_month: purchaseOn.slice(0, 7),
    line_role: "purchase",
    occurred_on: purchaseOn,
    purchase_on: purchaseOn,
    statement_date: "25/05/2026",
    amount_clp: 50_000,
    amount_usd: null,
    amount_usd_at_expense: null,
    merchant: "REFUND TEST SHOP",
    merchant_key: "REFUND TEST SHOP",
    installment_flag: 0,
    nro_cuota_current: 0,
    nro_cuota_total: 0,
    category_slug: "food",
    category_unique: false,
    purchase_key: `line-pr:refund-test-${partial.statement_line_id ?? 1}`,
    purchase_notes: "",
    big_group_slug: null,
    origin_label: "4242",
    origin: { kind: "card", account_name: null, card_last4: null, additional: false },
    origin_card_last4: null,
    primary_card_last4: null,
    flow_id: 1000 + (partial.statement_line_id ?? 1),
    ...partial,
  };
}

/** A card credit of 12.000 on 2026-06-02 (a partial refund). */
const credit = (partial: Partial<FlowCcExpenseLineRow> = {}) =>
  line({ statement_line_id: 9, purchase_on: "2026-06-02", amount_clp: -12_000, card_refund: true, category_slug: "unclassified", ...partial });

describe("cardRefundCandidates", () => {
  const lines = withLineMoney([
    line({ statement_line_id: 1, purchase_on: "2026-05-10", amount_clp: 50_000 }),
    // Another shop, bought later: a candidate after the merchant's own.
    line({ statement_line_id: 2, purchase_on: "2026-05-20", amount_clp: 30_000, merchant: "OTHER STORE", merchant_key: "OTHER STORE" }),
    // Worth less than the credit: never its purchase.
    line({ statement_line_id: 3, purchase_on: "2026-05-21", amount_clp: 5_000 }),
    // Bought after the credit, on another card, or more than 120 days before: out.
    line({ statement_line_id: 4, purchase_on: "2026-06-05", amount_clp: 50_000 }),
    line({ statement_line_id: 5, purchase_on: "2026-05-15", amount_clp: 50_000, account_id: 32 }),
    line({ statement_line_id: 6, purchase_on: "2026-01-15", amount_clp: 50_000 }),
    credit(),
  ]);
  const refund = lines.at(-1)!;

  it("lists the card's purchases worth at least the credit in the window, the merchant's own first", () => {
    expect(cardRefundCandidates(refundPurchaseIndex(lines), refund).map((c) => [c.line.statement_line_id, c.merchant_match])).toEqual([
      [1, true],
      [2, false],
    ]);
  });

  it("suggests the one same-merchant candidate, and none when two fit", () => {
    const [suggested] = withCardRefundLinks(lines, new Map()).filter((l) => l.statement_line_id === 9);
    expect(suggested!.refund_suggestion).toMatchObject({ line_id: 1, purchase_date: "2026-05-10", amount: { value: 50_000, currency: "clp" } });
    const twice = withLineMoney([...lines, line({ statement_line_id: 7, purchase_on: "2026-05-25", amount_clp: 40_000 })]);
    const [none] = withCardRefundLinks(twice, new Map()).filter((l) => l.statement_line_id === 9);
    expect(none!.refund_suggestion).toBeUndefined();
  });

  it("reads a linked credit as its purchase's refund, marked as the user's", () => {
    const linked = withCardRefundLinks(lines, new Map([[1009, 1002]])).find((l) => l.statement_line_id === 9)!;
    expect(linked.refund_of).toMatchObject({ line_id: 2, purchase_date: "2026-05-20", merchant: "OTHER STORE", manual: true });
    expect(linked.refund_suggestion).toBeUndefined();
    expect(isLinkableCardRefund(linked)).toBe(true);
  });

  it("follows a purchase a cuota plan took over to the plan's whole price", () => {
    const withPlan = withLineMoney([
      ...lines,
      line({
        statement_line_id: -30,
        line_role: "installment_purchase_total",
        installment_purchase_id: 30,
        purchase_on: "2026-05-12",
        amount_clp: 90_000,
        flow_id: 1030,
      }),
    ]);
    // Flow 1099 was a one-shot line plan 30 superseded: no expense line carries it.
    const linked = withCardRefundLinks(withPlan, new Map([[1009, 1099]]), (flow) => (flow === 1099 ? 30 : null)).find(
      (l) => l.statement_line_id === 9
    )!;
    expect(linked.refund_of).toMatchObject({ line_id: -30, manual: true });
  });

  it("marks a link no line stands for as broken, for the row to undo", () => {
    const broken = withCardRefundLinks(lines, new Map([[1009, 9999]]), () => null).find((l) => l.statement_line_id === 9)!;
    expect(broken.refund_link_broken).toBe(true);
    expect(broken.refund_of).toBeUndefined();
    expect(isLinkableCardRefund(broken)).toBe(true);
  });

  it("marks a link to a purchase on another card as broken (a re-homed statement)", () => {
    const moved = withLineMoney([...lines, line({ statement_line_id: 50, purchase_on: "2026-05-18", amount_clp: 40_000, account_id: 77, flow_id: 1050 })]);
    const broken = withCardRefundLinks(moved, new Map([[1009, 1050]]), () => null).find((l) => l.statement_line_id === 9)!;
    expect(broken.refund_link_broken).toBe(true);
    expect(broken.refund_of).toBeUndefined();
  });

  it("offers a purchase broken into pieces at its whole amount, under the line its pieces leave", () => {
    const pieces = withLineMoney([
      line({ statement_line_id: 40, purchase_on: "2026-05-15", amount_clp: 8_000, flow_id: 1040, piece_seq: 1 }),
      line({ statement_line_id: 40, purchase_on: "2026-05-15", amount_clp: 7_000, flow_id: 1040, pieces_remainder: true }),
      credit(),
    ]);
    const [c] = cardRefundCandidates(refundPurchaseIndex(pieces), pieces.at(-1)!);
    expect(c!.amount).toEqual({ value: 15_000, currency: "clp" });
    expect(c!.line.pieces_remainder).toBe(true);
  });

  it("only a card credit is linkable, and not one the bank already paired", () => {
    expect(isLinkableCardRefund(lines[0]!)).toBe(false);
    const paired = withLineMoney([
      credit({ refund_of: { line_id: 1, purchase_key: "line-pr:x", purchase_date: "2026-05-10", merchant: "X" } }),
    ])[0]!;
    expect(isLinkableCardRefund(paired)).toBe(false);
  });
});
