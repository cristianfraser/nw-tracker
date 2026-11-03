import { describe, expect, it } from "vitest";
import type { FlowCcExpenseLineRow } from "./flowsExpenses.js";
import { latestExpenseLines } from "./latestExpenses.js";

function line(over: Partial<FlowCcExpenseLineRow>): FlowCcExpenseLineRow {
  return {
    source: "cc",
    statement_line_id: 1,
    account_id: 1,
    expense_month: "2026-09",
    billing_month: "2026-09",
    occurred_on: "2026-09-10",
    purchase_on: "2026-09-10",
    statement_date: "",
    amount_clp: 10_000,
    amount_usd: null,
    amount_usd_at_expense: 10,
    merchant: "VITEST SHOP",
    merchant_key: "vitest shop",
    category_slug: "food",
    category_unique: false,
    installment_flag: 0,
    nro_cuota_current: null,
    nro_cuota_total: null,
    purchase_month: "2026-09",
    line_role: "purchase",
    purchase_key: "k",
    purchase_notes: "",
    big_group_slug: null,
    origin_label: "·0000",
    origin_card_last4: null,
    primary_card_last4: null,
    ...over,
  } as FlowCcExpenseLineRow;
}

const known = new Set(["food", "taxes", "deposits"]);

describe("latestExpenseLines", () => {
  it("lists the newest gastos lines in «Total» mode, refunds included, excluded categories out", () => {
    const lines = [
      line({ statement_line_id: 1, purchase_on: "2026-09-01" }),
      line({ statement_line_id: 2, purchase_on: "2026-09-05", category_slug: "taxes", source: "payslip" }),
      // Excluded category: never listed.
      line({ statement_line_id: 3, purchase_on: "2026-09-09", category_slug: "deposits" }),
      // A cuota line is the «Por cuota» view's; the purchase total is listed once.
      line({ statement_line_id: 4, purchase_on: "2026-09-07", line_role: "installment_cuota", installment_flag: 1, nro_cuota_current: 1, nro_cuota_total: 3 }),
      line({ statement_line_id: 5, purchase_on: "2026-09-07", line_role: "installment_purchase_total", installment_flag: 1, nro_cuota_total: 3, amount_clp: 30_000, amount_usd_at_expense: 30 }),
      line({ statement_line_id: 6, source: "checking", purchase_on: "2026-09-08", amount_clp: -2_000, amount_usd_at_expense: -2, checking_refund: true }),
      // After today: left out.
      line({ statement_line_id: 7, purchase_on: "2026-10-01" }),
    ];
    expect(latestExpenseLines(lines, known, 10, "2026-09-30").map((l) => l.statement_line_id)).toEqual([6, 5, 2, 1]);
    expect(latestExpenseLines(lines, known, 2, "2026-09-30").map((l) => l.statement_line_id)).toEqual([6, 5]);
  });

  it("throws on a category the catalog does not know", () => {
    expect(() => latestExpenseLines([line({ category_slug: "nope" })], known, 5, "2026-09-30")).toThrow(
      /unknown category/
    );
  });
});
