import { afterEach, describe, expect, it } from "vitest";
import {
  associatedCardLast4sForMaster,
  normalizeCcImportCardLast4,
  resolveMasterAccountIdForImportCardLast4,
} from "./ccConsolidatedCards.js";
import { resolveMasterAccountIdForCardLast4 } from "./creditCardTree.js";
import { db } from "./db.js";

describe("ccConsolidatedCards", () => {
  it("redirects predecessor and consolidated cards to successor masters", () => {
    expect(normalizeCcImportCardLast4("4113")).toBe("4141");
    expect(normalizeCcImportCardLast4("4114")).toBe("4141");
    expect(normalizeCcImportCardLast4("4111")).toBe("4242");
    expect(normalizeCcImportCardLast4("4112")).toBe("4242");
    expect(normalizeCcImportCardLast4("4141")).toBe("4141");
    expect(normalizeCcImportCardLast4("4242")).toBe("4242");
  });

  it("resolves import account id to 4242 master for redirected last4", () => {
    const perCard = dbHasPerCardMasters();
    if (!perCard) return;
    const id4242 = resolveMasterAccountIdForCardLast4("4242");
    expect(resolveMasterAccountIdForImportCardLast4("4111")).toBe(id4242);
    expect(resolveMasterAccountIdForImportCardLast4("4112")).toBe(id4242);
  });
});

describe("associatedCardLast4sForMaster", () => {
  const created: number[] = [];
  afterEach(() => {
    for (const id of created.splice(0)) db.prepare(`DELETE FROM accounts WHERE id = ?`).run(id);
  });

  function makeMaster(key: string, cardLast4: string | null): number {
    const bucket = db
      .prepare(`SELECT id FROM asset_groups WHERE slug IN ('credit_card', 'credit_cards__credit_card') LIMIT 1`)
      .get() as { id: number };
    // notes names a different card on purpose: the titular must come from the config row.
    const id = Number(
      db
        .prepare(`INSERT INTO accounts (asset_group_id, name, notes, import_key) VALUES (?, 'Vitest · titular', ?, ?)`)
        .run(bucket.id, "credit_card_master|santander|1111", `credit_card_master|santander|${key}`).lastInsertRowid
    );
    created.push(id);
    if (cardLast4 != null) {
      db.prepare(`INSERT INTO credit_card_account_config (account_id, card_last4) VALUES (?, ?)`).run(id, cardLast4);
    }
    return id;
  }

  it("puts the config last4 first as the titular, then the statements' other cards", () => {
    const id = makeMaster("vitest-titular-config", "9936");
    db.prepare(
      `INSERT INTO cc_statements (account_id, card_group, source_pdf, statement_date, card_last4, layout, currency)
       VALUES (?, 'santander', 'import:web-paste|vitest-titular', '20/05/2026', '5545', 'compact', 'clp')`
    ).run(id);
    expect(associatedCardLast4sForMaster(id)).toEqual(["9936", "5545"]);
  });

  it("throws for a master without a config last4", () => {
    const id = makeMaster("vitest-titular-no-config", null);
    expect(() => associatedCardLast4sForMaster(id)).toThrow(/credit_card_account_config\.card_last4/);
  });
});

function dbHasPerCardMasters(): boolean {
  return resolveMasterAccountIdForCardLast4("4242") != null;
}
