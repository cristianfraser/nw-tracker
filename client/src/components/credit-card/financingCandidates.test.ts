import { describe, expect, it } from "vitest";
import { financingCandidatesFromLines } from "./financingCandidates";
import type { FlowCcExpenseLineRow } from "../../types";

function line(
  partial: Partial<FlowCcExpenseLineRow> & Pick<FlowCcExpenseLineRow, "statement_line_id">
): FlowCcExpenseLineRow {
  return {
    source: "cc",
    account_id: 1,
    expense_month: "2025-01",
    billing_month: "2025-01",
    purchase_month: "2025-01",
    line_role: "installment_purchase_total",
    occurred_on: "2025-01-05",
    purchase_on: "2025-01-05",
    statement_date: "",
    amount_clp: 50_000,
    amount_usd: null,
    merchant: "STREAMING CO",
    merchant_key: "STREAMING CO",
    category_slug: "unclassified",
    category_unique: false,
    installment_flag: 1,
    nro_cuota_current: null,
    nro_cuota_total: 12,
    purchase_key: "installment-h:1:2025-01-05:12:50000:STREAMING CO",
    purchase_notes: "",
    big_group_slug: null,
    origin_label: "4242",
    amount_usd_at_expense: null,
    ...partial,
  };
}

describe("financingCandidatesFromLines", () => {
  it("lists identical twin plans once, with their count and combined principal", () => {
    const twins = [-1, -2, -3].map((id) => line({ statement_line_id: id }));
    const single = line({
      statement_line_id: -4,
      purchase_month: "2025-03",
      amount_clp: 90_000,
      merchant: "FURNITURE",
      purchase_key: "installment-h:1:2025-03-10:3:90000:FURNITURE",
    });
    const cuota = line({ statement_line_id: 7, line_role: "installment_cuota", amount_clp: 4_167 });
    const purchase = line({ statement_line_id: 8, line_role: "purchase", purchase_key: "line-pr:x" });

    const candidates = financingCandidatesFromLines([...twins, single, cuota, purchase]);

    expect(candidates.map((c) => [c.merchant, c.purchase_count, c.amount_clp])).toEqual([
      ["FURNITURE", 1, 90_000],
      ["STREAMING CO", 3, 150_000],
    ]);
    expect(new Set(candidates.map((c) => c.key)).size).toBe(candidates.length);
  });

  it("keeps the same purchase key on two cards apart — a link names the account too", () => {
    const candidates = financingCandidatesFromLines([
      line({ statement_line_id: -1, account_id: 1 }),
      line({ statement_line_id: -2, account_id: 2 }),
    ]);
    expect(candidates.map((c) => [c.account_id, c.purchase_count])).toEqual([
      [1, 1],
      [2, 1],
    ]);
  });
});
