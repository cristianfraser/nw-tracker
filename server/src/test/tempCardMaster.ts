import { db } from "../db.js";

/**
 * A card master a test owns: its own account and config row, so writes through the card funnel
 * (lines, anchors, valuations, billing snapshots) never land on the Vitest person's cards, whose
 * group totals other tests read. `deleteTempCardMaster` removes everything filed under it.
 */
export function createTempCardMaster(opts: { issuer: "santander" | "bci"; last4: string; key: string }): number {
  const bucket = db
    .prepare(`SELECT id FROM asset_groups WHERE slug IN ('credit_card', 'credit_cards__credit_card') LIMIT 1`)
    .get() as { id: number };
  const importKey = `credit_card_master|${opts.issuer}|${opts.key}`;
  const id = Number(
    db
      .prepare(`INSERT INTO accounts (asset_group_id, name, notes, import_key) VALUES (?, ?, ?, ?)`)
      .run(bucket.id, `Vitest · ${opts.key}`, importKey, importKey).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO credit_card_account_config (account_id, billing_cycle_start_day, billing_cycle_end_day, card_last4, issuer)
     VALUES (?, 21, 20, ?, ?)`
  ).run(id, opts.last4, opts.issuer);
  return id;
}

/** Deletes the master and every row naming it (any table with an `account_id`), statement lines included. */
export function deleteTempCardMaster(id: number): void {
  const tables = (
    db
      .prepare(
        `SELECT m.name FROM sqlite_master m WHERE m.type = 'table'
           AND EXISTS (SELECT 1 FROM pragma_table_info(m.name) c WHERE c.name = 'account_id')`
      )
      .all() as { name: string }[]
  ).map((t) => t.name);
  db.pragma("defer_foreign_keys = ON");
  db.transaction(() => {
    db.prepare(
      `DELETE FROM cc_statement_lines WHERE statement_id IN (SELECT id FROM cc_statements WHERE account_id = ?)`
    ).run(id);
    db.prepare(
      `DELETE FROM cc_installment_payments WHERE purchase_id IN (SELECT id FROM cc_installment_purchases WHERE account_id = ?)`
    ).run(id);
    for (const t of tables) db.prepare(`DELETE FROM "${t}" WHERE account_id = ?`).run(id);
    db.prepare(`DELETE FROM accounts WHERE id = ?`).run(id);
  })();
}
