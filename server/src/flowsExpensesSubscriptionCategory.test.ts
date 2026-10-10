import { describe, expect, it } from "vitest";
import { withSubscriptionCategory } from "./flowsExpenses.js";

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
    expect(out.some((l) => "category_from_bank_name" in l)).toBe(false);
  });
});
