import { describe, expect, it } from "vitest";
import { bookLedgerEditSchemaForAccount } from "./accountBookLedgerEdit.js";
import { db } from "./db.js";

/** The Vitest person's account under the leaf asset group `slug` (the test DB always has one). */
function personAccountId(slug: string): number {
  const row = db
    .prepare(`SELECT a.id FROM accounts a JOIN asset_groups g ON g.id = a.asset_group_id WHERE g.slug = ? ORDER BY a.id LIMIT 1`)
    .get(slug) as { id: number } | undefined;
  if (!row) throw new Error(`the Vitest person has no account under ${slug}`);
  return row.id;
}

describe("bookLedgerEditSchemaForAccount", () => {
  it("exposes book ledger edit for a cuenta de ahorro vivienda (book marks + peso flows)", () => {
    const groupId = (db.prepare(`SELECT id FROM asset_groups WHERE slug = 'cash_eqs__cuenta_ahorro_vivienda'`).get() as { id: number }).id;
    const id = Number(
      db.prepare(`INSERT INTO accounts (name, asset_group_id) VALUES ('vitest book-ledger ahorro', ?)`).run(groupId).lastInsertRowid
    );
    try {
      expect(bookLedgerEditSchemaForAccount(id)).toEqual({
        valuations: true,
        movements: { units_delta: "optional" },
      });
    } finally {
      db.prepare(`DELETE FROM accounts WHERE id = ?`).run(id);
    }
  });

  it("returns null for AFC (its manual flows carry cuotas)", () => {
    expect(bookLedgerEditSchemaForAccount(personAccountId("retirement_afp_afc__afc"))).toBeNull();
  });

  it("returns null for equity MTM (SPY)", () => {
    expect(bookLedgerEditSchemaForAccount(personAccountId("brokerage_acciones__spy"))).toBeNull();
  });

  it("returns null for AFP (a cuota ledger)", () => {
    expect(bookLedgerEditSchemaForAccount(personAccountId("retirement_afp_afc__afp"))).toBeNull();
  });

  it("returns null for checking (cuenta corriente)", () => {
    expect(bookLedgerEditSchemaForAccount(personAccountId("cash_eqs__cuenta_corriente"))).toBeNull();
  });

  it("returns null for a fund valued from cuotas", () => {
    expect(bookLedgerEditSchemaForAccount(personAccountId("brokerage_mutual_funds__fintual_risky_norris"))).toBeNull();
  });
});
