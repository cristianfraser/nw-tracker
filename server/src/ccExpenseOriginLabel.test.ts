import { describe, expect, it } from "vitest";
import { db } from "./db.js";
import {
  enrichFlowLinesWithOriginLabels,
  expenseLineOriginLabel,
  loadAccountNameById,
} from "./ccExpenseOriginLabel.js";
import { cardLast4ForCreditCardAccount } from "./ccManualBillingMonth.js";
import { cartolaCashAccountIdOptional } from "./movementBalanceCashAccounts.js";
import { listCreditCardMasterAccountIds } from "./creditCardTree.js";

describe("ccExpenseOriginLabel", () => {
  it("uses card last4 for credit card accounts", () => {
    const ccIds = listCreditCardMasterAccountIds();
    if (ccIds.length === 0) return;
    const id = ccIds[0]!;
    const last4 = cardLast4ForCreditCardAccount(id);
    if (!last4) return;
    const names = loadAccountNameById([id]);
    expect(expenseLineOriginLabel(id, "cc", names)).toBe(last4);
  });

  it("uses account name for checking", () => {
    const checkingId = cartolaCashAccountIdOptional("cuenta_corriente");
    if (checkingId == null) return;
    const row = db
      .prepare(`SELECT name FROM accounts WHERE id = ?`)
      .get(checkingId) as { name: string };
    const names = loadAccountNameById([checkingId]);
    expect(expenseLineOriginLabel(checkingId, "checking", names)).toBe(row.name);
  });

  it("enrichFlowLinesWithOriginLabels sets origin_label on every line", () => {
    const ccIds = listCreditCardMasterAccountIds();
    if (ccIds.length === 0) return;
    const enriched = enrichFlowLinesWithOriginLabels([
      {
        source: "cc",
        statement_line_id: 1,
        account_id: ccIds[0]!,
        expense_month: "2025-01",
        billing_month: "2025-01",
        purchase_month: "2025-01",
        line_role: "purchase",
        occurred_on: "2025-01-20",
        purchase_on: "2025-01-15",
        statement_date: "20/01/2025",
        amount_clp: 1000,
        amount_usd: null,
        merchant: "TEST",
        merchant_key: "TEST",
        installment_flag: 0,
        nro_cuota_current: null,
        nro_cuota_total: null,
        category_slug: "unclassified",
        category_unique: false,
        purchase_key: "k",
        purchase_notes: "",
      },
    ]);
    expect(enriched[0]?.origin_label).toBeTruthy();
    expect(enriched[0]?.origin_label).toMatch(/^\d{4}$|./);
  });
});
