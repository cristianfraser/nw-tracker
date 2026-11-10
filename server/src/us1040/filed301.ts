import type { Database as DatabaseType } from "better-sqlite3";
import { writeLogTriggerSql } from "../markInputTriggers.js";

/**
 * Migration 300 hook: the write-log triggers of the filed-1040 tables (F2 — a new table's writes
 * reach the caches through the change log). Pure (no `db` import — the module graph is still
 * initializing when it runs).
 */
export const F1040_FILED_TABLES_300 = ["us_f1040_returns", "us_f1040_filed_lines", "us_f1040_settlements"] as const;

export function runF1040Filed300(dbi: DatabaseType): void {
  for (const table of F1040_FILED_TABLES_300) {
    const columns = (dbi.prepare(`SELECT name FROM pragma_table_info('${table}')`).all() as { name: string }[]).map((c) => c.name);
    for (const sql of writeLogTriggerSql(table, columns, null)) dbi.exec(sql);
  }
}
