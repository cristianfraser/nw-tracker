import { describe, expect, it } from "vitest";
import { db } from "./db.js";
import { creditCardInstallmentsResponse } from "./creditCardInstallments.js";

describe("creditCardInstallmentsResponse runtime", () => {
  it("returns source none without reading cfraser CSV when account has no ledger or statements", () => {
    const row = db
      .prepare(
        `SELECT a.id FROM accounts a
         JOIN asset_groups g ON g.id = a.asset_group_id
         WHERE g.slug LIKE 'credit_card%'
           AND NOT EXISTS (SELECT 1 FROM cc_installment_purchases p WHERE p.account_id = a.id)
           AND NOT EXISTS (SELECT 1 FROM cc_statements s WHERE s.account_id = a.id)
         LIMIT 1`
      )
      .get() as { id: number } | undefined;
    if (!row) return;

    const res = creditCardInstallmentsResponse(row.id, {});
    expect(res.has_installment_ledger).toBe(false);
    expect(res.has_imported_statements).toBe(false);
    expect(res.purchases).toEqual([]);
    expect(res.meta).toBeNull();
  });

  it("includes associated_card_last4s with titular first", () => {
    // Synthetic master + statements: real Santander masters no longer carry statements
    // (manual-entry era), so live-row pickers found only unusable fixtures. Web-paste
    // source_pdf keeps the on-disk-PDF invariants out of play.
    const bucket = db
      .prepare(
        `SELECT id FROM asset_groups WHERE slug IN ('credit_card', 'credit_cards__credit_card') LIMIT 1`
      )
      .get() as { id: number } | undefined;
    if (!bucket) return;

    const masterId = Number(
      db
        .prepare(
          `INSERT INTO accounts (asset_group_id, name, notes, account_kind)
           VALUES (?, 'Vitest · last4s fixture', ?, 'master')`
        )
        .run(bucket.id, "credit_card_master|santander|9977").lastInsertRowid
    );
    db.prepare(
      `INSERT INTO credit_card_account_config (account_id, billing_cycle_start_day, billing_cycle_end_day, card_last4)
       VALUES (?, 21, 20, '9977')`
    ).run(masterId);
    const insStmt = db.prepare(
      `INSERT INTO cc_statements (
         account_id, card_group, source_pdf, statement_date, period_from, period_to,
         card_last4, layout, currency
       ) VALUES (?, 'santander', ?, '20/05/2026', '21/04/2026', '20/05/2026', ?, 'compact', 'clp')`
    );
    const s1 = Number(insStmt.run(masterId, "import:web-paste|vitest-last4s|titular", "9977").lastInsertRowid);
    const s2 = Number(insStmt.run(masterId, "import:web-paste|vitest-last4s|adicional", "5544").lastInsertRowid);

    try {
      const res = creditCardInstallmentsResponse(masterId, {});
      expect(res.associated_card_last4s).toBeDefined();
      expect(res.associated_card_last4s![0]).toBe("9977");
      expect(res.associated_card_last4s).toContain("5544");
    } finally {
      db.prepare(`DELETE FROM cc_statements WHERE id IN (?, ?)`).run(s1, s2);
      db.prepare(`DELETE FROM credit_card_account_config WHERE account_id = ?`).run(masterId);
      db.prepare(`DELETE FROM accounts WHERE id = ?`).run(masterId);
    }
  });
});
