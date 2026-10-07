import { afterEach, describe, expect, it } from "vitest";
import { db } from "./db.js";
import {
  facturadoFromStatement,
  incrementalChargesClpForBillingMonth,
  normalizedPostCloseLines,
  statementHeaderFacturado,
  sumRevolvingChargesClpForStatementDate,
} from "./ccBillingBalances.js";
import { facturadoClpUsdForStatementSlot } from "./ccBillingViews.js";
import { statementSlotsByBillingMonth } from "./ccBillingStatementSlots.js";
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

describe("statementSlotsByBillingMonth", () => {
  it("picks primary CLP facturado for 4242 Oct 2025 multi-card month", () => {
    const master = db
      .prepare(`SELECT id FROM accounts WHERE notes = 'credit_card_master|santander|4242'`)
      .get() as { id: number } | undefined;
    if (!master) return;

    const slot = statementSlotsByBillingMonth(master.id).get("2025-10");
    if (!slot?.clp) return;

    const { facturado_clp } = facturadoClpUsdForStatementSlot(master.id, slot);
    expect(facturado_clp).toBeGreaterThan(100_000);
    expect(facturado_clp).not.toBeLessThan(3_000_000);
  });
});

describe("normalizedPostCloseLines", () => {
  let accountId = 0;

  afterEach(() => {
    db.prepare(`DELETE FROM cc_statements WHERE account_id = ?`).run(accountId);
    db.prepare(`DELETE FROM accounts WHERE id = ?`).run(accountId);
  });

  it("dates each line by its transaction date, else its posting date", () => {
    const group = db.prepare(`SELECT id FROM asset_groups LIMIT 1`).get() as { id: number };
    accountId = Number(
      db
        .prepare(`INSERT INTO accounts (asset_group_id, name, import_key) VALUES (?, ?, ?)`)
        .run(group.id, "Vitest · post-close line dates", "vitest-cc-post-close-line-dates").lastInsertRowid
    );
    const statementId = Number(
      db
        .prepare(
          `INSERT INTO cc_statements (account_id, card_group, source_pdf, statement_date, layout, currency)
           VALUES (?, 'A', 'vitest line dates.pdf', '24/09/2026', 'compact', 'clp')`
        )
        .run(accountId).lastInsertRowid
    );
    const insertLine = db.prepare(
      `INSERT INTO cc_statement_lines (statement_id, transaction_date, posting_date, merchant, amount_clp, installment_flag, dedupe_key)
       VALUES (?, ?, ?, ?, ?, 0, ?)`
    );
    insertLine.run(statementId, "03/09/2026", "05/09/2026", "VITEST BOTH DATES", 10_000, "vitest-both");
    // A line that prints only its posting date used to drop out of the owed walk altogether.
    insertLine.run(statementId, null, "07/09/2026", "VITEST POSTING ONLY", 20_000, "vitest-posting");
    const lines = normalizedPostCloseLines(accountId).map((l) => [l.key, l.iso, l.clp]);
    expect(lines).toEqual([
      ["vitest-both", "2026-09-03", 10_000],
      ["vitest-posting", "2026-09-07", 20_000],
    ]);
  });

  it("dates a backdated line (two cycles or more before its statement) at that statement's close", () => {
    const group = db.prepare(`SELECT id FROM asset_groups LIMIT 1`).get() as { id: number };
    accountId = Number(
      db
        .prepare(`INSERT INTO accounts (asset_group_id, name, import_key) VALUES (?, ?, ?)`)
        .run(group.id, "Vitest · backdated nota", "vitest-cc-backdated-nota").lastInsertRowid
    );
    const statementId = Number(
      db
        .prepare(
          `INSERT INTO cc_statements (account_id, card_group, source_pdf, statement_date, layout, currency)
           VALUES (?, 'A', 'vitest backdated.pdf', '25/06/2036', 'compact', 'clp')`
        )
        .run(accountId).lastInsertRowid
    );
    const insertLine = db.prepare(
      `INSERT INTO cc_statement_lines (statement_id, transaction_date, posting_date, merchant, amount_clp, installment_flag, dedupe_key)
       VALUES (?, ?, ?, ?, ?, 0, ?)`
    );
    // A nota de crédito carrying its purchase's date, printed four months later: billed at this close.
    insertLine.run(statementId, "22/02/2036", "22/02/2036", "NOTA DE CREDITO", -445_842, "vitest-nota");
    // Exactly two months before the close counts as backdated too; a day later is a late posting.
    insertLine.run(statementId, "25/04/2036", "25/04/2036", "VITEST TWO CYCLES", 1_000, "vitest-two");
    insertLine.run(statementId, "26/04/2036", "26/04/2036", "VITEST LATE", 2_000, "vitest-late");
    const lines = normalizedPostCloseLines(accountId).map((l) => [l.key, l.iso]);
    expect(lines).toEqual([
      ["vitest-nota", "2036-06-25"],
      ["vitest-two", "2036-06-25"],
      ["vitest-late", "2036-04-26"],
    ]);
  });
});

describe("statementHeaderFacturado", () => {
  it("takes the billed amount as printed, credit and zero included; none only when nothing is printed", () => {
    expect(statementHeaderFacturado({ monto_facturado: 246_343 })).toBe(246_343);
    expect(statementHeaderFacturado({ monto_facturado: -256_727 })).toBe(-256_727);
    expect(statementHeaderFacturado({ monto_facturado: 0 })).toBe(0);
    expect(statementHeaderFacturado({ monto_facturado: null })).toBeNull();
  });
});
