import { describe, expect, it } from "vitest";
import {
  assignableCcExpenseCategories,
  ccExpenseCategoryPathLabel,
} from "./ccExpenseCategories";
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

