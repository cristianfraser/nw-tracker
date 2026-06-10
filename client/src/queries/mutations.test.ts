import { describe, expect, it } from "vitest";
import {
  applyCcExpenseLineCategoryPatch,
  applyCcExpenseLineCategoryPatchFromServer,
} from "./mutations";
import type { FlowsCreditCardExpensesResponse } from "../types";

function sampleData(): FlowsCreditCardExpensesResponse {
  return {
    group_slug: "pasivos",
    account_ids: [32],
    categories: [],
    big_groups: [],
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
        big_group_slug: null,
        origin_label: "4242",
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
      source: "cc",
      unique: true,
      category_slug: "food",
    });
    expect(next?.lines[0].category_slug).toBe("food");
    expect(next?.lines[0].category_unique).toBe(true);
  });

  it("clears category to unclassified", () => {
    const next = applyCcExpenseLineCategoryPatch(sampleData(), {
      lineId: 42,
      source: "cc",
      unique: false,
      clear_category: true,
    });
    expect(next?.lines[0].category_slug).toBe("unclassified");
  });

  it("patches by category_statement_line_id anchor (installment total row)", () => {
    const data: FlowsCreditCardExpensesResponse = {
      ...sampleData(),
      lines: [
        {
          ...sampleData().lines[0],
          statement_line_id: -29,
          line_role: "installment_purchase_total",
          category_statement_line_id: 501,
          category_unique: false,
          purchase_key: "installment-h:32:2025-01-01:12:TEST",
        },
        {
          ...sampleData().lines[0],
          statement_line_id: 501,
          line_role: "installment_cuota",
          category_unique: false,
          purchase_key: "installment-h:32:2025-01-01:12:TEST",
        },
      ],
    };
    const next = applyCcExpenseLineCategoryPatch(data, {
      lineId: 501,
      source: "cc",
      unique: true,
    });
    expect(next?.lines.every((ln) => ln.source === "cc" && ln.category_unique)).toBe(true);
  });

  it("does not patch cc line when source is checking (id collision)", () => {
    const data: FlowsCreditCardExpensesResponse = {
      ...sampleData(),
      lines: [
        { ...sampleData().lines[0], source: "cc", statement_line_id: 999, category_unique: false },
        {
          ...sampleData().lines[0],
          source: "checking",
          statement_line_id: 999,
          merchant: "Cargo Mercado Capitales",
          purchase_key: "checking-mv:999",
          category_unique: false,
        },
      ],
    };
    const next = applyCcExpenseLineCategoryPatch(data, {
      lineId: 999,
      source: "checking",
      unique: true,
    });
    expect(next?.lines.find((ln) => ln.source === "checking")?.category_unique).toBe(true);
    expect(next?.lines.find((ln) => ln.source === "cc")?.category_unique).toBe(false);
  });

  it("applyCcExpenseLineCategoryPatchFromServer updates all lines with purchase_key", () => {
    const data: FlowsCreditCardExpensesResponse = {
      ...sampleData(),
      lines: [
        { ...sampleData().lines[0], statement_line_id: 10, purchase_key: "pk-a", category_unique: false },
        { ...sampleData().lines[0], statement_line_id: 11, purchase_key: "pk-a", category_unique: false },
        { ...sampleData().lines[0], statement_line_id: 12, purchase_key: "pk-b", category_unique: false },
      ],
    };
    const next = applyCcExpenseLineCategoryPatchFromServer(data, {
      accountId: 32,
      purchaseKey: "pk-a",
      category_slug: "fun",
      unique: true,
    });
    expect(next?.lines[0].category_unique).toBe(true);
    expect(next?.lines[0].category_slug).toBe("fun");
    expect(next?.lines[1].category_unique).toBe(true);
    expect(next?.lines[2].category_unique).toBe(false);
  });
});
