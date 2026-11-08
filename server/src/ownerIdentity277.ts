import type { Database as DatabaseType } from "better-sqlite3";
import { writeLogTriggerSql } from "./markInputTriggers.js";

/**
 * Migration 277 hook: the write-log triggers of `owner_identity` (F2 — a new table's writes reach
 * the caches through the change log). Pure (no `db` import — the module graph is still
 * initializing when it runs).
 */
export function runOwnerIdentity277(dbi: DatabaseType): void {
  const columns = (dbi.prepare(`SELECT name FROM pragma_table_info('owner_identity')`).all() as { name: string }[]).map(
    (c) => c.name
  );
  for (const sql of writeLogTriggerSql("owner_identity", columns, null)) dbi.exec(sql);
}
