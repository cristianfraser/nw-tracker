import type { Database as DatabaseType } from "better-sqlite3";
import { writeLogTriggerSql } from "../markInputTriggers.js";

/**
 * Migration 365 hook: the write-log triggers of `card_refund_links` (a new table's writes reach the
 * caches through the change log). Pure (no `db` import — the module graph is still initializing).
 */
export function runCardRefundLinks365(dbi: DatabaseType): void {
  const table = "card_refund_links";
  const columns = (dbi.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as { name: string }[]).map((c) => c.name);
  if (columns.length === 0) throw new Error(`migration 365: table ${table} does not exist`);
  for (const sql of writeLogTriggerSql(table, columns, null)) dbi.exec(sql);
}
