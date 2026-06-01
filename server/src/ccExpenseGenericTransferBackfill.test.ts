import { describe, expect, it } from "vitest";
import { db } from "./db.js";
import { backfillGenericTransferUniquePurchases } from "./ccExpenseGenericTransferBackfill.js";
import {
  isGenericTransferMerchantKey,
  loadCcStatementLineExpenseCtx,
  normalizeCcExpenseMerchantKey,
  stableCcExpensePurchaseKeyFromCtx,
} from "./ccExpenseCategories.js";

describe("backfillGenericTransferUniquePurchases", () => {
  it("is idempotent", () => {
    const first = backfillGenericTransferUniquePurchases();
    const second = backfillGenericTransferUniquePurchases();
    expect(second.inserted).toBe(0);
    expect(first.inserted).toBeGreaterThanOrEqual(0);
  });

  it("inserts unique row for Santander internet transfer template", () => {
    const sample = normalizeCcExpenseMerchantKey("Transf. Internet a otro Bancos");
    expect(isGenericTransferMerchantKey(sample)).toBe(true);

    const row = db
      .prepare(
        `SELECT l.id, s.account_id
         FROM cc_statement_lines l
         JOIN cc_statements s ON s.id = l.statement_id
         WHERE upper(trim(l.merchant)) LIKE '%TRANSF%INTERNET%OTRO%BANCO%'
         LIMIT 1`
      )
      .get() as { id: number; account_id: number } | undefined;
    if (!row) return;

    const ctx = loadCcStatementLineExpenseCtx(row.id);
    if (!ctx) return;
    const purchaseKey = stableCcExpensePurchaseKeyFromCtx(ctx);
    db.prepare(
      `DELETE FROM cc_expense_unique_purchases WHERE account_id = ? AND purchase_key = ?`
    ).run(row.account_id, purchaseKey);

    const { inserted } = backfillGenericTransferUniquePurchases();
    expect(inserted).toBeGreaterThan(0);

    const has = db
      .prepare(
        `SELECT 1 AS o FROM cc_expense_unique_purchases WHERE account_id = ? AND purchase_key = ?`
      )
      .get(row.account_id, purchaseKey);
    expect(has).toBeTruthy();
  });
});
