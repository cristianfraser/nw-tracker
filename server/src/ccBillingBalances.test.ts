import { describe, expect, it } from "vitest";
import { db } from "./db.js";
import {
  facturadoFromStatement,
  incrementalChargesClpForBillingMonth,
  sumRevolvingChargesClpForStatementDate,
} from "./ccBillingBalances.js";
import { ledgerFacturadoClpForBillingMonth } from "./ccInstallmentLedgerDb.js";
import { billingMonthForManualLedgerPurchase } from "./ccManualBillingMonth.js";
import { listCcStatementsForAccount } from "./ccStatementsDb.js";

describe("facturadoFromStatement", () => {
  it("uses ledger fallback when charges-only revolving is not positive", () => {
    const master = db
      .prepare(`SELECT id FROM accounts WHERE notes = 'credit_card_master|santander|4242'`)
      .get() as { id: number } | undefined;
    if (!master) return;

    const openBm = billingMonthForManualLedgerPurchase(master.id);
    if (!openBm) return;

    const stmt = listCcStatementsForAccount(master.id).find(
      (s) =>
        s.billing_month === openBm &&
        String(s.source_pdf ?? "").startsWith("import:web-paste")
    );
    if (!stmt) return;

    const chargesOnly = sumRevolvingChargesClpForStatementDate(master.id, stmt.statement_date);
    const ledger = ledgerFacturadoClpForBillingMonth(master.id, openBm);
    const derived = facturadoFromStatement(
      master.id,
      stmt.statement_date,
      stmt,
      stmt.statement_date_iso
    );

    if (chargesOnly <= 0 && ledger > 0) {
      expect(derived.facturado_clp).toBe(ledger);
      return;
    }
    expect(chargesOnly).toBeGreaterThan(0);
    expect(derived.facturado_clp).toBeGreaterThanOrEqual(chargesOnly);
    expect(incrementalChargesClpForBillingMonth(master.id, openBm)).toBe(chargesOnly);
  });
});
