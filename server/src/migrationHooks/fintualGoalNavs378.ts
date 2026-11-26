import type { Database as DatabaseType } from "better-sqlite3";
import { writeLogTriggerSql } from "../markInputTriggers.js";

/** Migration 378 hook: the write-log triggers of `fintual_goal_navs` (its writes reach the caches). Pure. */
export function runFintualGoalNavs378(dbi: DatabaseType): void {
  const table = "fintual_goal_navs";
  const columns = (dbi.prepare(`SELECT name FROM pragma_table_info('${table}')`).all() as { name: string }[]).map((c) => c.name);
  for (const sql of writeLogTriggerSql(table, columns, null)) dbi.exec(sql);
}
