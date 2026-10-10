import { describe, expect, it } from "vitest";
import { withSubscriptionCategory } from "./flowsExpenses.js";

describe("withSubscriptionCategory", () => {
  const line = (category_slug: string, byDefault: boolean, subscription: boolean | null) => ({
    category_slug,
    ...(byDefault ? { category_by_default: true as const } : {}),
    ...(subscription == null ? {} : { payment_receipt: { subscription } }),
  });

  it("files an uncategorized subscription charge under Suscripciones and leaves every other line alone", () => {
    const out = withSubscriptionCategory([
      line("unclassified", true, true),
      line("unclassified", true, false),
      line("unclassified", true, null),
      line("unclassified", false, true),
      line("fun", false, true),
    ]);
    expect(out.map((l) => l.category_slug)).toEqual(["subscriptions", "unclassified", "unclassified", "unclassified", "fun"]);
    expect(out.some((l) => "category_by_default" in l)).toBe(false);
  });
});
