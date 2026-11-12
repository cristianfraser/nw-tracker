import type { Database as DatabaseType } from "better-sqlite3";
import { writeLogTriggerSql } from "./markInputTriggers.js";

/**
 * Migration 311 hook: the write-log triggers of `card_to_card_payments` (F2 — a new table's writes
 * reach the caches through the change log), and the trigger that deletes a row's transfer when the
 * row goes: a deleted facturado payment record cascades its rows away, and the transfers it named
 * must not outlive it. Pure (no `db` import — the module graph is still initializing when it runs).
 */
export const CARD_TO_CARD_PAYMENTS_TABLE_311 = "card_to_card_payments";

export const CARD_TO_CARD_PAYMENT_DELETE_TRIGGER_SQL = `CREATE TRIGGER card_to_card_payments_ad AFTER DELETE ON card_to_card_payments BEGIN
  DELETE FROM movements WHERE id = OLD.movement_id;
END`;

export function runCardToCardPayments311(dbi: DatabaseType): void {
  const columns = (
    dbi.prepare(`SELECT name FROM pragma_table_info('${CARD_TO_CARD_PAYMENTS_TABLE_311}')`).all() as { name: string }[]
  ).map((c) => c.name);
  for (const sql of writeLogTriggerSql(CARD_TO_CARD_PAYMENTS_TABLE_311, columns, null)) dbi.exec(sql);
  dbi.exec(CARD_TO_CARD_PAYMENT_DELETE_TRIGGER_SQL);
}
