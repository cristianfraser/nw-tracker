import { describe, expect, it } from "vitest";
import { db } from "./db.js";
import {
  createExpenseGenericUniqueMerchant,
  deleteExpenseGenericUniqueMerchant,
  invalidateExpenseGenericUniqueMerchantCache,
  isExactGenericUniqueMerchantKey,
  listExpenseGenericUniqueMerchants,
  updateExpenseGenericUniqueMerchant,
} from "./expenseGenericUniqueMerchants.js";

describe("expenseGenericUniqueMerchants", () => {
  it("lists seeded exact merchant keys", () => {
    const rows = listExpenseGenericUniqueMerchants();
    expect(rows.some((r) => r.merchant_key === "MACH ONE CLICK")).toBe(true);
    expect(rows.some((r) => r.merchant_key === "TRASPASO A CUENTA DE OTRO BANCO")).toBe(true);
  });

  it("create update delete round-trip", () => {
    const key = `VITEST GENERIC MERCHANT ${Date.now()}`;
    const row = createExpenseGenericUniqueMerchant(key);
    expect(row.merchant_key).toBe(key);
    expect(isExactGenericUniqueMerchantKey(key)).toBe(true);

    const nextKey = `${key} EDIT`;
    const updated = updateExpenseGenericUniqueMerchant(row.id, nextKey);
    expect(updated.merchant_key).toBe(nextKey);
    expect(isExactGenericUniqueMerchantKey(key)).toBe(false);
    expect(isExactGenericUniqueMerchantKey(nextKey)).toBe(true);

    deleteExpenseGenericUniqueMerchant(row.id);
    invalidateExpenseGenericUniqueMerchantCache();
    expect(isExactGenericUniqueMerchantKey(nextKey)).toBe(false);
    expect(
      db
        .prepare(`SELECT 1 AS o FROM cc_expense_generic_unique_merchants WHERE id = ?`)
        .get(row.id)
    ).toBeUndefined();
  });
});
