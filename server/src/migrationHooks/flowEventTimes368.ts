import type { Database as DatabaseType } from "better-sqlite3";
import { writeLogTriggerSql } from "../markInputTriggers.js";

/** Migration 368 hook: the write-log triggers of `flow_event_times` (its writes reach the caches). Pure. */
export function runFlowEventTimes368(dbi: DatabaseType): void {
  const table = "flow_event_times";
  const columns = (dbi.prepare(`SELECT name FROM pragma_table_info('${table}')`).all() as { name: string }[]).map((c) => c.name);
  for (const sql of writeLogTriggerSql(table, columns, null)) dbi.exec(sql);
}
