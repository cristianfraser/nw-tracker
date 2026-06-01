import { describe, expect, it } from "vitest";
import { db } from "./db.js";
import {
  createCcExpenseGenericUniqueMerchant,
  deleteCcExpenseGenericUniqueMerchant,
  invalidateCcExpenseGenericUniqueMerchantCache,
  isExactGenericUniqueMerchantKey,
  listCcExpenseGenericUniqueMerchants,
  updateCcExpenseGenericUniqueMerchant,
} from "./ccExpenseGenericUniqueMerchants.js";

describe("ccExpenseGenericUniqueMerchants", () => {
  it("lists seeded exact merchant keys", () => {
    const rows = listCcExpenseGenericUniqueMerchants();
    expect(rows.some((r) => r.merchant_key === "MACH ONE CLICK")).toBe(true);
    expect(rows.some((r) => r.merchant_key === "TRASPASO A CUENTA DE OTRO BANCO")).toBe(true);
  });

  it("create update delete round-trip", () => {
    const key = `VITEST GENERIC MERCHANT ${Date.now()}`;
    const row = createCcExpenseGenericUniqueMerchant(key);
    expect(row.merchant_key).toBe(key);
    expect(isExactGenericUniqueMerchantKey(key)).toBe(true);

    const nextKey = `${key} EDIT`;
    const updated = updateCcExpenseGenericUniqueMerchant(row.id, nextKey);
    expect(updated.merchant_key).toBe(nextKey);
    expect(isExactGenericUniqueMerchantKey(key)).toBe(false);
    expect(isExactGenericUniqueMerchantKey(nextKey)).toBe(true);

    deleteCcExpenseGenericUniqueMerchant(row.id);
    invalidateCcExpenseGenericUniqueMerchantCache();
    expect(isExactGenericUniqueMerchantKey(nextKey)).toBe(false);
    expect(
      db
        .prepare(`SELECT 1 AS o FROM cc_expense_generic_unique_merchants WHERE id = ?`)
        .get(row.id)
    ).toBeUndefined();
  });
});
