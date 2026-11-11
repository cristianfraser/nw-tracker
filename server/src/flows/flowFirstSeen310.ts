import type { Database as DatabaseType } from "better-sqlite3";
import { writeLogTriggerSql } from "../markInputTriggers.js";

/**
 * Migration 310 hook: the write-log triggers of `flow_first_seen` (F2 — a new table's writes reach
 * the caches through the change log: the expense lines read it). Pure (no `db` import — the module
 * graph is still initializing when it runs).
 */
export const FLOW_FIRST_SEEN_TABLE_310 = "flow_first_seen";

export function runFlowFirstSeen310(dbi: DatabaseType): void {
  const columns = (
    dbi.prepare(`SELECT name FROM pragma_table_info('${FLOW_FIRST_SEEN_TABLE_310}')`).all() as { name: string }[]
  ).map((c) => c.name);
  for (const sql of writeLogTriggerSql(FLOW_FIRST_SEEN_TABLE_310, columns, null)) dbi.exec(sql);
}
