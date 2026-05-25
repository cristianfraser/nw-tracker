import { describe, expect, it } from "vitest";
import { applyCcExpenseLineCategoryPatch } from "./mutations";
import type { FlowsCreditCardExpensesResponse } from "../types";

function sampleData(): FlowsCreditCardExpensesResponse {
  return {
    group_slug: "pasivos",
    account_ids: [32],
    categories: [],
    lines: [
      {
        source: "cc",
        statement_line_id: 42,
        account_id: 32,
        expense_month: "2025-05",
        billing_month: "2025-05",
        purchase_month: "2025-05",
        line_role: "purchase",
        occurred_on: "2025-05-10",
        purchase_on: "2025-05-10",
        statement_date: "22/05/2025",
        amount_clp: 10_000,
        merchant: "TEST",
        merchant_key: "TEST",
        installment_flag: 0,
        nro_cuota_current: null,
        nro_cuota_total: null,
        category_slug: "supermarket",
        category_unique: false,
        purchase_key: "line-pr:test",
        purchase_notes: "",
      },
    ],
    by_month: [],
    chart_monthly: [],
    chart_monthly_by_category: [],
    total_clp: 10_000,
    total_real_clp: 10_000,
  };
}

describe("applyCcExpenseLineCategoryPatch", () => {
  it("updates category and unique on the matching line", () => {
    const next = applyCcExpenseLineCategoryPatch(sampleData(), {
      lineId: 42,
      unique: true,
      category_slug: "food",
    });
    expect(next?.lines[0].category_slug).toBe("food");
    expect(next?.lines[0].category_unique).toBe(true);
  });

  it("clears category to unclassified", () => {
    const next = applyCcExpenseLineCategoryPatch(sampleData(), {
      lineId: 42,
      unique: false,
      clear_category: true,
    });
    expect(next?.lines[0].category_slug).toBe("unclassified");
  });
});
