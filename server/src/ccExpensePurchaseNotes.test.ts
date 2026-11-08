import { fixtureMovement } from "./test/flowFixtures.js";
import { describe, expect, it } from "vitest";
import { listCreditCardMasterAccountIds } from "./creditCardTree.js";
import { checkingAccountId } from "./checkingCartolaImport.js";
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
    const dropMovement = fixtureMovement(990_287_001);
    const purchaseKey = "checking-mv:990287001";
    setCcExpensePurchaseNote({
      accountId,
      purchaseKey,
      notes: "  birthday gift  ",
    });
    expect(getCcExpensePurchaseNote(accountId, purchaseKey)).toBe("birthday gift");
    setCcExpensePurchaseNote({ accountId, purchaseKey, notes: "" });
    expect(getCcExpensePurchaseNote(accountId, purchaseKey)).toBe("");
    dropMovement();
  });

  it("persists notes for checking gastos account", () => {
    let checkingId: number;
    try {
      checkingId = checkingAccountId();
    } catch {
      return;
    }
    const dropMovement = fixtureMovement(990_287_002);
    const purchaseKey = "checking-mv:990287002";
    setCcExpensePurchaseNote({
      accountId: checkingId,
      purchaseKey,
      notes: "transfer memo",
    });
    expect(getCcExpensePurchaseNote(checkingId, purchaseKey)).toBe("transfer memo");
    setCcExpensePurchaseNote({ accountId: checkingId, purchaseKey, notes: "" });
    dropMovement();
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
      amount_usd_at_expense: null,
      origin_card_last4: null,
      primary_card_last4: null,
    };
    const [enriched] = enrichFlowLinesWithPurchaseNotes([draft], notes);
    expect(enriched.purchase_key).toBe(purchaseKey);
    expect(enriched.purchase_notes).toBe("test note");
  });
});
