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
    const row = db
      .prepare(
        `SELECT a.id FROM accounts a
         WHERE a.notes LIKE 'credit_card_master|santander|%'
           AND EXISTS (SELECT 1 FROM cc_statements s WHERE s.account_id = a.id)
         LIMIT 1`
      )
      .get() as { id: number } | undefined;
    if (!row) return;

    const res = creditCardInstallmentsResponse(row.id, {});
    expect(res.associated_card_last4s?.length).toBeGreaterThan(0);
    const masterNotes = db
      .prepare(`SELECT notes FROM accounts WHERE id = ?`)
      .get(row.id) as { notes: string };
    const titular = masterNotes.notes.split("|").at(-1);
    expect(res.associated_card_last4s![0]).toBe(titular);
  });
});
