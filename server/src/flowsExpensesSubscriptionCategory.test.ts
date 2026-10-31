import { describe, expect, it } from "vitest";
import { withSpecificCategoryRules, withSubscriptionCategory } from "./flowsExpenses.js";
import { clearExpenseCategoryRule, setExpenseCategoryRule } from "./expenseCategoryRules.js";
import { getCcExpenseCategoryBySlug } from "./ccExpenseCategories.js";

describe("withSubscriptionCategory", () => {
  const line = (category_slug: string, fromBankName: boolean, subscription: boolean | null) => ({
    category_slug,
    ...(fromBankName ? { category_from_bank_name: true as const } : {}),
    ...(subscription == null ? {} : { payment_receipt: { subscription } }),
  });

  it("files a subscription charge the bank's name categorized under Suscripciones and leaves every other line alone", () => {
    const out = withSubscriptionCategory([
      line("unclassified", true, true),
      line("transportation", true, true),
      line("unclassified", true, false),
      line("transportation", true, null),
      line("unclassified", false, true),
      line("fun", false, true),
    ]);
    expect(out.map((l) => l.category_slug)).toEqual(["subscriptions", "subscriptions", "unclassified", "transportation", "unclassified", "fun"]);
    // The marker stays for the specific-rule step.
    expect(out.filter((l) => "category_from_bank_name" in l)).toHaveLength(4);
  });
});

describe("withSpecificCategoryRules", () => {
  const MERCHANT = "VITEST DELIVERY APP";
  const link = { kind: "receipt" as const, key: "VITEST GROCER" };
  const line = (category_slug: string, fromBankName: boolean, withLink: boolean) => ({
    category_slug,
    merchant: MERCHANT,
    ...(fromBankName ? { category_from_bank_name: true as const } : {}),
    ...(withLink ? { category_link: link } : {}),
  });

  it("a specific rule places a line the bank's name decided; a line's own category stays", () => {
    const supermarket = getCcExpenseCategoryBySlug("supermarket")!;
    setExpenseCategoryRule(MERCHANT, link, supermarket.id);
    try {
      const out = withSpecificCategoryRules([
        line("food", true, true),
        line("food", true, false),
        line("fun", false, true),
      ]);
      expect(out.map((l) => l.category_slug)).toEqual(["supermarket", "food", "fun"]);
      expect(out.map((l) => "category_specific" in l)).toEqual([true, false, false]);
      expect(out.some((l) => "category_from_bank_name" in l)).toBe(false);
    } finally {
      clearExpenseCategoryRule(MERCHANT, link);
    }
  });

  it("a recipient rule reaches every wording of a transfer to that person", () => {
    const fun = getCcExpenseCategoryBySlug("fun")!;
    const recipient = { kind: "recipient" as const, key: "11111111K" };
    setExpenseCategoryRule("Transf. Internet a otro Bancos", recipient, fun.id);
    try {
      const out = withSpecificCategoryRules([
        { category_slug: "unclassified", merchant: "Agustinas Transf. Internet a otro Bancos", category_from_bank_name: true as const, category_link: recipient },
        { category_slug: "unclassified", merchant: "Transf a ANA PRUEBA", category_from_bank_name: true as const, category_link: recipient },
      ]);
      expect(out.map((l) => l.category_slug)).toEqual(["fun", "fun"]);
    } finally {
      clearExpenseCategoryRule("x", recipient);
    }
  });
});
