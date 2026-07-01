import { describe, expect, it } from "vitest";
import { resolvePurchaseKeyForGastosLine } from "./ccExpensePurchaseKey.js";
import { checkingGastosMovementPurchaseKey } from "./flowsCheckingGastos.js";
import type { FlowCcExpenseLineBeforeNotes } from "./ccExpensePurchaseNotes.js";

function line(partial: Partial<FlowCcExpenseLineBeforeNotes> = {}): FlowCcExpenseLineBeforeNotes {
  return {
    source: "cc",
    account_id: 1,
    statement_line_id: 0,
    expense_month: "2025-01",
    billing_month: "2025-01",
    purchase_month: "2025-01",
    line_role: "installment_cuota",
    occurred_on: "2025-01-20",
    purchase_on: "2024-12-15",
    statement_date: "20/01/2025",
    amount_clp: 10_000,
    amount_usd: null,
    merchant: "TEST SHOP",
    merchant_key: "TEST SHOP",
    installment_flag: 1,
    nro_cuota_current: 2,
    nro_cuota_total: 6,
    category_slug: "unclassified",
    category_unique: false,
    ...partial,
  };
}

describe("resolvePurchaseKeyForGastosLine", () => {
  it("uses installment-h for ledger cuota lines without statement id", () => {
    const key = resolvePurchaseKeyForGastosLine(
      line({ statement_line_id: -2_000_000_001 })
    );
    expect(key).toBe("installment-h:1:2024-12-15:6:TEST SHOP");
  });

  it("falls back to installment-h when synthetic total has no anchor line in db", () => {
    const key = resolvePurchaseKeyForGastosLine(
      line({
        statement_line_id: -99,
        line_role: "installment_purchase_total",
        category_statement_line_id: null,
        installment_flag: 1,
      })
    );
    expect(key).toBe("installment-h:1:2024-12-15:6:TEST SHOP");
  });

  it("uses stable checking cartola key for cuenta corriente gastos lines", () => {
    const key = resolvePurchaseKeyForGastosLine(
      line({ source: "checking", statement_line_id: 42, line_role: "purchase" })
    );
    expect(key).toBe(checkingGastosMovementPurchaseKey(42));
  });

  it("includes the total so same-identity purchases get distinct keys", () => {
    // Two EXPRESS-PLAZA-L-style purchases: same account/date/cuotas/merchant, different amount.
    const a = resolvePurchaseKeyForGastosLine(
      line({ statement_line_id: -1, installment_total_clp: 1_267_034 })
    );
    const b = resolvePurchaseKeyForGastosLine(
      line({ statement_line_id: -2, installment_total_clp: 1_200_000 })
    );
    expect(a).toBe("installment-h:1:2024-12-15:6:1267034:TEST SHOP");
    expect(b).toBe("installment-h:1:2024-12-15:6:1200000:TEST SHOP");
    expect(a).not.toBe(b);
  });
});
