import type { Database as DatabaseType } from "better-sqlite3";
import { writeLogTriggerSql } from "./markInputTriggers.js";

/**
 * Migration 299 hook: the write-log triggers of the two tables it changed. `flow_income_overrides`
 * was rebuilt (its triggers went with the old table); `expense_accounts` gained columns its update
 * trigger does not watch yet (the trigger lists the columns it compares). Pure (no `db` import —
 * the module graph is still initializing when it runs).
 */
export function runRentalPlaces299(dbi: DatabaseType): void {
  for (const table of ["flow_income_overrides", "expense_accounts"]) {
    for (const kind of ["ai", "ad", "au"]) dbi.exec(`DROP TRIGGER IF EXISTS write_log_${table}_${kind}`);
    const columns = (dbi.prepare(`SELECT name FROM pragma_table_info('${table}')`).all() as { name: string }[]).map(
      (c) => c.name
    );
    for (const sql of writeLogTriggerSql(table, columns, null)) dbi.exec(sql);
  }
}
