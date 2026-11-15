import type { Database as DatabaseType } from "better-sqlite3";
import { writeLogTriggerSql } from "../markInputTriggers.js";

/**
 * Migration 359 hook (untangle wave 9, `ut-bank-currency`): a mirror merge keeps each deleted leg
 * as an amount in its own currency. `out_amount_clp` / `in_amount_clp` held the legs signed in the
 * transfer's currency whatever it was (a euro pair stored euros under a peso name); they become
 * `out_amount` + `out_currency` and `in_amount` + `in_currency`. Every row on file takes its
 * transfer's currency: both legs of a movement pair are in it, and a card-payment merge keeps its
 * checking debit and the transfer's own amount, which are the transfer's currency too.
 *
 * The table is rebuilt (columns renamed and added), its rows copied and counted, its mark triggers
 * re-created as they were (they read the dates only) and its write-log trigger regenerated for the
 * new columns, in the same order. Nothing references the table. Pure: no `db` import.
 */

const TABLE = "movement_mirror_merges";
const MARK_WATCH = ["transfer_movement_id", "out_occurred_on", "in_occurred_on"] as const;
const WRITE_LOG_TRIGGER = `write_log_${TABLE}_au`;

export function runMirrorMergeAmountCurrency359(dbi: DatabaseType): void {
  const triggers = dbi
    .prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ? ORDER BY rowid`)
    .all(TABLE) as { name: string; sql: string }[];
  const indexes = dbi
    .prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL AND tbl_name = ? ORDER BY rowid`)
    .all(TABLE) as { name: string; sql: string }[];
  for (const t of triggers) {
    if (t.name !== WRITE_LOG_TRIGGER && /amount_clp/.test(t.sql)) {
      throw new Error(`migration 359: trigger ${t.name} reads a renamed column`);
    }
  }
  const before = (dbi.prepare(`SELECT COUNT(*) AS c FROM ${TABLE}`).get() as { c: number }).c;
  dbi.exec(`CREATE TABLE movement_mirror_merges_359 (
  transfer_movement_id INTEGER PRIMARY KEY REFERENCES movements(id) ON DELETE CASCADE,
  out_movement_id INTEGER NOT NULL,
  out_occurred_on TEXT NOT NULL,
  out_amount REAL NOT NULL,
  out_currency TEXT NOT NULL REFERENCES currencies(code),
  out_units_delta REAL,
  out_note TEXT,
  in_movement_id INTEGER,
  in_statement_line_id INTEGER,
  in_statement_id INTEGER,
  in_occurred_on TEXT NOT NULL,
  in_amount REAL NOT NULL,
  in_currency TEXT NOT NULL REFERENCES currencies(code),
  in_units_delta REAL,
  in_note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (
    (in_movement_id IS NOT NULL) + (in_statement_line_id IS NOT NULL) + (in_statement_id IS NOT NULL) = 1
  )
)`);
  dbi.exec(`INSERT INTO movement_mirror_merges_359
      (transfer_movement_id, out_movement_id, out_occurred_on, out_amount, out_currency, out_units_delta, out_note,
       in_movement_id, in_statement_line_id, in_statement_id, in_occurred_on, in_amount, in_currency, in_units_delta,
       in_note, created_at)
    SELECT mm.transfer_movement_id, mm.out_movement_id, mm.out_occurred_on, mm.out_amount_clp, m.currency,
           mm.out_units_delta, mm.out_note, mm.in_movement_id, mm.in_statement_line_id, mm.in_statement_id,
           mm.in_occurred_on, mm.in_amount_clp, m.currency, mm.in_units_delta, mm.in_note, mm.created_at
    FROM ${TABLE} mm JOIN movements m ON m.id = mm.transfer_movement_id`);
  const copied = (dbi.prepare(`SELECT COUNT(*) AS c FROM movement_mirror_merges_359`).get() as { c: number }).c;
  if (copied !== before) {
    throw new Error(`migration 359: ${TABLE} had ${before} row(s), ${copied} have a transfer movement to take a currency from`);
  }
  dbi.exec(`DROP TABLE ${TABLE}`);
  dbi.pragma("legacy_alter_table = ON");
  try {
    dbi.exec(`ALTER TABLE movement_mirror_merges_359 RENAME TO ${TABLE}`);
  } finally {
    dbi.pragma("legacy_alter_table = OFF");
  }
  for (const ix of indexes) dbi.exec(ix.sql);
  const columns = (dbi.prepare(`PRAGMA table_info(${TABLE})`).all() as { name: string }[]).map((c) => c.name);
  const writeLog = writeLogTriggerSql(TABLE, columns, MARK_WATCH);
  if (writeLog.length !== 1) throw new Error(`migration 359: expected one write-log trigger for ${TABLE}`);
  for (const t of triggers) dbi.exec(t.name === WRITE_LOG_TRIGGER ? writeLog[0]! : t.sql);
  const fk = dbi.prepare(`PRAGMA foreign_key_check(${TABLE})`).all();
  if (fk.length > 0) throw new Error(`migration 359: foreign key check failed: ${JSON.stringify(fk.slice(0, 5))}`);
}
