import type { Database as DatabaseType } from "better-sqlite3";
import { writeLogTriggerSql } from "../markInputTriggers.js";

/**
 * Migration 385 hook: the write-log update trigger of `expense_category_rules` over its columns now
 * (`origin`), so a rule's origin reaches the caches through the change log.
 * Pure (no `db` import — the module graph is still initializing).
 */
export function runCategoryRuleOrigin385(dbi: DatabaseType): void {
  const table = "expense_category_rules";
  const columns = (dbi.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as { name: string }[]).map((c) => c.name);
  if (!columns.includes("origin")) throw new Error(`migration 385: ${table}.origin does not exist`);
  const update = writeLogTriggerSql(table, columns, null).find((sql) => sql.startsWith(`CREATE TRIGGER write_log_${table}_au `));
  if (!update) throw new Error(`migration 385: no write-log update trigger for ${table}`);
  dbi.exec(`DROP TRIGGER IF EXISTS write_log_${table}_au`);
  dbi.exec(update);
}
