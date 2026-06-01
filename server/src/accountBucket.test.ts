import { describe, expect, it } from "vitest";
import { accountBucketKindSlug } from "./accountBucket.js";

describe("accountBucketKindSlug", () => {
  it("extracts kind from nested asset group slugs", () => {
    expect(accountBucketKindSlug("credit_cards__credit_card")).toBe("credit_card");
    expect(accountBucketKindSlug("cash_eqs__cuenta_corriente")).toBe("cuenta_corriente");
    expect(accountBucketKindSlug("credit_card")).toBe("credit_card");
  });
});
