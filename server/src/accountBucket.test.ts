import { describe, expect, it } from "vitest";
import { db } from "./db.js";
import { getAccountPositionMeta } from "./accountPosition.js";
import { accountBucketKindSlug, accountKindSlugForAccountId } from "./accountBucket.js";

describe("accountBucketKindSlug", () => {
  it("extracts kind from nested asset group slugs", () => {
    expect(accountBucketKindSlug("credit_cards__credit_card")).toBe("credit_card");
    expect(accountBucketKindSlug("cash_eqs__cuenta_corriente")).toBe("cuenta_corriente");
    expect(accountBucketKindSlug("credit_card")).toBe("credit_card");
    expect(accountBucketKindSlug("liabilities__mortgage")).toBe("mortgage");
    expect(accountBucketKindSlug("real_estate__property")).toBe("property");
    expect(accountBucketKindSlug("retirement_afp_afc__afp")).toBe("afp");
    expect(accountBucketKindSlug("retirement_afp_afc__afc")).toBe("afc");
  });
});

describe("accountKindSlugForAccountId", () => {
  it("uses asset group kind for AFP under retirement_afp_afc nav (not afp_afc)", () => {
    const row = db
      .prepare(
        `SELECT a.id FROM accounts a
         WHERE a.notes LIKE 'import:excel|key=afp%'
         LIMIT 1`
      )
      .get() as { id: number } | undefined;
    if (!row) return;

    expect(accountKindSlugForAccountId(row.id)).toBe("afp");

    const meta = getAccountPositionMeta(row.id, "afp");
    expect(meta?.ticker).toBe("UNO-A");
    expect(meta?.units_kind).toBe("shares");
  });
});
