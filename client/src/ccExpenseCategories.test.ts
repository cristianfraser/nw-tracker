import { describe, expect, it } from "vitest";
import {
  assignableCcExpenseCategories,
  chartCcExpenseCategories,
} from "./ccExpenseCategories";
import type { FlowCcExpenseCategoryChartPoint } from "./types";
import type { CcExpenseCategoryDto } from "./types";

function cat(slug: string, sort_order: number): CcExpenseCategoryDto {
  return {
    id: sort_order,
    slug,
    label: slug,
    label_i18n_key: `expenses.creditCard.categories.${slug}`,
    sort_order,
    chart_color: "#000",
  };
}

describe("assignableCcExpenseCategories", () => {
  it("pins no_cuenta and deposits first, otros last, middle A–Z", () => {
    const slugs = assignableCcExpenseCategories([
      cat("transportation", 40),
      cat("others", 90),
      cat("food", 30),
      cat("deposits", 5),
      cat("bills", 10),
      cat("unclassified", 0),
      cat("no_cuenta", 4),
    ]).map((c) => c.slug);
    expect(slugs).toEqual([
      "no_cuenta",
      "deposits",
      "food",
      "bills",
      "transportation",
      "others",
    ]);
  });
});

describe("chartCcExpenseCategories", () => {
  it("orders by average monthly gasto desc; others penultimate; unclassified last", () => {
    const categories = [
      cat("food", 30),
      cat("bills", 10),
      cat("transportation", 40),
      cat("others", 90),
      cat("unclassified", 0),
      cat("no_cuenta", 4),
    ];
    const points: FlowCcExpenseCategoryChartPoint[] = [
      {
        as_of_date: "2025-01-31",
        food: 100,
        bills: 500,
        transportation: 50,
        others: 10_000,
      },
      {
        as_of_date: "2025-02-28",
        food: 100,
        bills: 300,
        transportation: 50,
        others: 10_000,
      },
    ];
    const slugs = chartCcExpenseCategories(categories, points).map((c) => c.slug);
    expect(slugs).toEqual(["bills", "food", "transportation", "others", "unclassified"]);
  });
});
