import { describe, expect, it } from "vitest";
import {
  assignableCcExpenseCategories,
  ccExpenseCategoriesAtLevel,
  ccExpenseCategoryPathLabel,
  ccExpenseCategorySlugAtLevel,
  chartCcExpenseCategories,
} from "./ccExpenseCategories";
import type { FlowCcExpenseCategoryChartPoint } from "./types";
import type { CcExpenseCategoryDto } from "./types";

function cat(slug: string, sort_order: number, parent_slug: string | null = null): CcExpenseCategoryDto {
  return {
    id: sort_order,
    slug,
    label: slug,
    label_i18n_key: `expenses.creditCard.categories.${slug}`,
    sort_order,
    chart_color: "#000",
    parent_slug,
  };
}

describe("subcategories", () => {
  const cats = [cat("transportation", 40), cat("taxes", 11, "bills"), cat("bills", 10), cat("pension_fees", 12, "bills"), cat("food", 30)];

  it("a picker lists each subcategory right after its parent", () => {
    expect(assignableCcExpenseCategories(cats).map((c) => c.slug)).toEqual(["food", "bills", "pension_fees", "taxes", "transportation"]);
  });

  it("labels a subcategory with its parent", () => {
    expect(ccExpenseCategoryPathLabel(cat("taxes", 11, "bills"))).toBe("Cuentas y servicios › Impuestos");
    expect(ccExpenseCategoryPathLabel(cat("bills", 10))).toBe("Cuentas y servicios");
  });

  it("at the category level a subcategory's spend folds into its parent", () => {
    const at = ccExpenseCategorySlugAtLevel(cats, "category");
    expect(["taxes", "pension_fees", "bills", "food"].map(at)).toEqual(["bills", "bills", "bills", "food"]);
    expect(ccExpenseCategoriesAtLevel(cats, "category").map((c) => c.slug)).toEqual(["transportation", "bills", "food"]);
    expect(ccExpenseCategorySlugAtLevel(cats, "subcategory")("taxes")).toBe("taxes");
    expect(ccExpenseCategoriesAtLevel(cats, "subcategory")).toHaveLength(5);
  });
});

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
