import { describe, expect, it } from "vitest";
import { db } from "./db.js";
import { facturadoFromStatement } from "./ccBillingBalances.js";
import { ledgerFacturadoClpForBillingMonth } from "./ccInstallmentLedgerDb.js";
import { listCcStatementsForAccount } from "./ccStatementsDb.js";

describe("facturadoFromStatement ledger fallback", () => {
  it("uses ledger when statement-derived facturado is not positive", () => {
    const master = db
      .prepare(`SELECT id FROM accounts WHERE notes = 'credit_card_master|santander|4242'`)
      .get() as { id: number } | undefined;
    if (!master) return;

    const stmt = listCcStatementsForAccount(master.id).find((s) => s.billing_month === "2026-05");
    if (!stmt) return;

    const ledger = ledgerFacturadoClpForBillingMonth(master.id, "2026-05");
    const derived = facturadoFromStatement(
      master.id,
      stmt.statement_date,
      stmt,
      stmt.statement_date_iso
    );
    if (ledger > 0) {
      expect(derived.facturado_clp).toBe(ledger);
    }
  });
});
