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
    const master4141 = db
      .prepare(`SELECT id FROM accounts WHERE notes = 'credit_card_master|santander|4141'`)
      .get() as { id: number } | undefined;
    if (master4141) {
      expect(notes).toContain("credit_card_master|santander|4141");
    }
  });
});
