import { describe, expect, it } from "vitest";
import { db } from "./db.js";
import { seedCreditCardTree } from "./seedCreditCardTree.js";

describe("seedCreditCardTree", () => {
  it("sets issuer-specific route_path (not shared credit-card parent)", () => {
    seedCreditCardTree();
    const rows = db
      .prepare(`SELECT slug, route_path FROM credit_card_groups WHERE slug IN ('santander', 'bci')`)
      .all() as { slug: string; route_path: string }[];
    const bySlug = Object.fromEntries(rows.map((r) => [r.slug, r.route_path]));
    expect(bySlug.santander).toBe("/liabilities/credit-card/santander");
    expect(bySlug.bci).toBe("/liabilities/credit-card/bci");
  });

  it("links only live Santander masters (excludes superseded 4111/4112)", () => {
    // Own fixtures: the superseded pair (hardcoded in ccConsolidatedCards.ts) plus a live
    // master, created only when absent and removed after.
    const fixtureNotes = [
      "credit_card_master|santander|4111",
      "credit_card_master|santander|4112",
      "credit_card_master|santander|4242",
    ];
    const group = db
      .prepare(`SELECT id FROM asset_groups WHERE slug = 'credit_cards__credit_card'`)
      .get() as { id: number };
    const createdIds: number[] = [];
    for (const n of fixtureNotes) {
      const exists = db.prepare(`SELECT 1 FROM accounts WHERE import_key = ?`).get(n) != null;
      if (exists) continue;
      // Superseded masters carry exclude_from_group_totals=1 (isSupersededSantanderCcMaster
      // requires it alongside the hardcoded notes + a resolvable successor).
      const superseded = n !== "credit_card_master|santander|4242";
      createdIds.push(
        Number(
          db
            .prepare(
              `INSERT INTO accounts (asset_group_id, name, notes, import_key, account_kind, exclude_from_group_totals)
               VALUES (?, ?, ?, ?, 'master', ?)`
            )
            .run(group.id, `CC fixture ${n.slice(-4)}`, n, n, superseded ? 1 : 0).lastInsertRowid
        )
      );
      // Card identity lives on the config row (resolveMasterAccountIdForCardLast4).
      db.prepare(
        `INSERT OR IGNORE INTO credit_card_account_config (account_id, card_last4) VALUES (?, ?)`
      ).run(createdIds[createdIds.length - 1], n.slice(-4));
    }
    try {
      seedCreditCardTree();
      const rows = db
        .prepare(
          `SELECT a.notes
           FROM credit_card_group_items i
           JOIN credit_card_groups g ON g.id = i.group_id
           JOIN accounts a ON a.id = i.account_id
           WHERE g.slug = 'santander' AND i.item_kind = 'account'
           ORDER BY a.notes`
        )
        .all() as { notes: string | null }[];
      const notes = rows.map((r) => r.notes);
      expect(notes).not.toContain("credit_card_master|santander|4111");
      expect(notes).not.toContain("credit_card_master|santander|4112");
      expect(notes).toContain("credit_card_master|santander|4242");
    } finally {
      for (const id of createdIds) {
        db.prepare(`DELETE FROM credit_card_account_config WHERE account_id = ?`).run(id);
        db.prepare(`DELETE FROM accounts WHERE id = ?`).run(id);
      }
      seedCreditCardTree();
    }
  });
});
