import type { Database as DatabaseType } from "better-sqlite3";
import { writeLogTriggerSql } from "../markInputTriggers.js";
import { FLOW_FIRST_SEEN_TABLE_310 } from "./flowFirstSeen310.js";

/**
 * Migration 367 hook: reinstalls the write-log triggers of `flow_first_seen` so the update trigger
 * watches the new time and order columns. Pure (no `db` import).
 */
export function runFlowFirstSeenTime367(dbi: DatabaseType): void {
  const table = FLOW_FIRST_SEEN_TABLE_310;
  const columns = (dbi.prepare(`SELECT name FROM pragma_table_info('${table}')`).all() as { name: string }[]).map((c) => c.name);
  for (const kind of ["ai", "ad", "au"]) dbi.exec(`DROP TRIGGER IF EXISTS write_log_${table}_${kind}`);
  for (const sql of writeLogTriggerSql(table, columns, null)) dbi.exec(sql);
}
