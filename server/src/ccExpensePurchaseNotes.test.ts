import { describe, expect, it } from "vitest";
import { listCreditCardMasterAccountIds } from "./creditCardTree.js";
import { checkingAccountId } from "./checkingCartolaImport.js";
import { db } from "./db.js";
import {
  enrichFlowLinesWithPurchaseNotes,
  getCcExpensePurchaseNote,
  purchaseNotesMapKey,
  setCcExpensePurchaseNote,
} from "./ccExpensePurchaseNotes.js";
import type { FlowCcExpenseLineBeforeNotes } from "./ccExpensePurchaseNotes.js";

describe("ccExpensePurchaseNotes", () => {
  it("persists and loads notes by account and purchase_key", () => {
    const accountId = listCreditCardMasterAccountIds()[0];
    if (accountId == null) return;
    const purchaseKey = `installment-h:${accountId}:2024-06-01:3:MERCHANT`;
    setCcExpensePurchaseNote({
      accountId,
      purchaseKey,
      notes: "  birthday gift  ",
    });
    expect(getCcExpensePurchaseNote(accountId, purchaseKey)).toBe("birthday gift");
    setCcExpensePurchaseNote({ accountId, purchaseKey, notes: "" });
    expect(getCcExpensePurchaseNote(accountId, purchaseKey)).toBe("");
    db.prepare(
      `DELETE FROM cc_expense_purchase_notes WHERE account_id = ? AND purchase_key = ?`
    ).run(accountId, purchaseKey);
  });

  it("persists notes for checking gastos account", () => {
    let checkingId: number;
    try {
      checkingId = checkingAccountId();
    } catch {
      return;
    }
    const purchaseKey = "checking-mv:test-note";
    setCcExpensePurchaseNote({
      accountId: checkingId,
      purchaseKey,
      notes: "transfer memo",
    });
    expect(getCcExpensePurchaseNote(checkingId, purchaseKey)).toBe("transfer memo");
    setCcExpensePurchaseNote({ accountId: checkingId, purchaseKey, notes: "" });
    db.prepare(
      `DELETE FROM cc_expense_purchase_notes WHERE account_id = ? AND purchase_key = ?`
    ).run(checkingId, purchaseKey);
  });

  it("enriches flow lines with purchase_key and purchase_notes", () => {
    const accountId = 42;
    const purchaseKey = "line-fallback:42:SHOP:2024-01-01";
    const notes = new Map([[purchaseNotesMapKey(accountId, purchaseKey), "test note"]]);
    const draft: FlowCcExpenseLineBeforeNotes = {
      source: "cc",
      statement_line_id: 0,
      account_id: accountId,
      expense_month: "2024-01",
      billing_month: "2024-01",
      purchase_month: "2024-01",
      line_role: "purchase",
      occurred_on: "2024-01-20",
      purchase_on: "2024-01-01",
      statement_date: "",
      amount_clp: 1000,
      amount_usd: null,
      merchant: "SHOP",
      merchant_key: "SHOP",
      installment_flag: 0,
      nro_cuota_current: null,
      nro_cuota_total: null,
      category_slug: "unclassified",
      category_unique: false,
    };
    const [enriched] = enrichFlowLinesWithPurchaseNotes([draft], notes);
    expect(enriched.purchase_key).toBe(purchaseKey);
    expect(enriched.purchase_notes).toBe("test note");
  });
});
