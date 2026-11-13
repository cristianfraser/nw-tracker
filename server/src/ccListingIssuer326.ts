import type { Database as DatabaseType } from "better-sqlite3";
import { writeLogTriggerSql } from "./markInputTriggers.js";

/**
 * Migration 326 hook: `cc_bank_cupo_captures` has a new column (`issuer`) and
 * `cc_planted_payment_lines` was rebuilt (its write-log triggers went with the old table), so both
 * tables' write-log triggers are re-created over their columns now. Pure (no `db` import — the
 * module graph is still initializing when it runs).
 */
export function runCcListingIssuer326(dbi: DatabaseType): void {
  for (const table of ["cc_bank_cupo_captures", "cc_planted_payment_lines"]) {
    for (const k of ["ai", "ad", "au"]) dbi.exec(`DROP TRIGGER IF EXISTS write_log_${table}_${k}`);
    const columns = (dbi.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as { name: string }[]).map((c) => c.name);
    if (columns.length === 0) throw new Error(`migration 326: table ${table} does not exist`);
    for (const sql of writeLogTriggerSql(table, columns, null)) dbi.exec(sql);
  }
}
