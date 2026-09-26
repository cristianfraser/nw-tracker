import { afterEach, describe, expect, it } from "vitest";
import { buildAccountDetailBundle } from "./accountDetailBundle.js";
import { db } from "./db.js";

describe("accountDetailBundle credit-card ledger", () => {
  const created: number[] = [];
  afterEach(() => {
    for (const id of created.splice(0)) db.prepare(`DELETE FROM accounts WHERE id = ?`).run(id);
  });

  function makeMaster(key: string, cardLast4: string | null): number {
    const bucket = db
      .prepare(`SELECT id FROM asset_groups WHERE slug IN ('credit_card', 'credit_cards__credit_card') LIMIT 1`)
      .get() as { id: number };
    const importKey = `credit_card_master|santander|${key}`;
    const id = Number(
      db
        .prepare(`INSERT INTO accounts (asset_group_id, name, notes, import_key) VALUES (?, 'Vitest · detail bundle', ?, ?)`)
        .run(bucket.id, importKey, importKey).lastInsertRowid
    );
    created.push(id);
    if (cardLast4 != null) {
      db.prepare(`INSERT INTO credit_card_account_config (account_id, card_last4) VALUES (?, ?)`).run(id, cardLast4);
    }
    return id;
  }

  it("builds the card's ledger for a master with its identity", async () => {
    const id = makeMaster("vitest-bundle-config", "9937");
    const bundle = await buildAccountDetailBundle(id, "clp", "monthly", {});
    expect(bundle?.ccLedger.associated_card_last4s).toEqual(["9937"]);
  });

  it("fails the bundle when the ledger cannot be built, instead of serving an empty ledger", async () => {
    const id = makeMaster("vitest-bundle-no-config", null);
    await expect(buildAccountDetailBundle(id, "clp", "monthly", {})).rejects.toThrow(
      /credit_card_account_config\.card_last4/
    );
  });
});
