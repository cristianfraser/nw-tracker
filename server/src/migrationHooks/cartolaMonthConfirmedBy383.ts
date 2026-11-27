import type { Database as DatabaseType } from "better-sqlite3";
import { writeLogTriggerSql } from "../markInputTriggers.js";

/**
 * Migration 383 hook: the write-log update trigger of `checking_cartola_imports` over its columns
 * now (the confirming document's two), so a confirmation reaches the caches through the change log.
 * Pure (no `db` import — the module graph is still initializing).
 */
export function runCartolaMonthConfirmedBy383(dbi: DatabaseType): void {
  const table = "checking_cartola_imports";
  const columns = (dbi.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as { name: string }[]).map((c) => c.name);
  if (!columns.includes("confirmed_by_file")) throw new Error(`migration 383: ${table}.confirmed_by_file does not exist`);
  const update = writeLogTriggerSql(table, columns, null).find((sql) => sql.startsWith(`CREATE TRIGGER write_log_${table}_au `));
  if (!update) throw new Error(`migration 383: no write-log update trigger for ${table}`);
  dbi.exec(`DROP TRIGGER IF EXISTS write_log_${table}_au`);
  dbi.exec(update);
}
