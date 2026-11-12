import type { Database as DatabaseType } from "better-sqlite3";
import { currentFlowInsertTriggerSql } from "./flowTables279.js";

/**
 * Migration 317 hook: databases migrated before the options work (migration 304) carry the
 * movements flow-insert trigger as migration 290 last installed it, without the `option_*` flow
 * kinds; a fresh database installs it from the current specs, kinds included. This re-creates it from
 * the current specs where it differs. A table's triggers fire in reverse creation order and the
 * change log depends on it, so every trigger of `movements` is dropped and re-created in its
 * original order, only `flow_movements_ai` with new text. Pure: no `db` import.
 */
export function runMovementFlowTrigger317(dbi: DatabaseType): { reinstalled: boolean } {
  const target = "flow_movements_ai";
  const wanted = currentFlowInsertTriggerSql("movements");
  const triggers = dbi
    .prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'movements' ORDER BY rowid`)
    .all() as { name: string; sql: string }[];
  const installed = triggers.find((t) => t.name === target);
  if (!installed) throw new Error(`migration 317: ${target} is not installed`);
  if (installed.sql === wanted) return { reinstalled: false };
  for (const t of triggers) dbi.exec(`DROP TRIGGER ${t.name}`);
  for (const t of triggers) dbi.exec(t.name === target ? wanted : t.sql);
  const after = dbi
    .prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'movements' ORDER BY rowid`)
    .all() as { name: string; sql: string }[];
  const names = (rows: { name: string }[]) => rows.map((r) => r.name).join(",");
  if (names(after) !== names(triggers)) {
    throw new Error(`migration 317: movements triggers changed order (${names(triggers)} → ${names(after)})`);
  }
  if (after.find((t) => t.name === target)?.sql !== wanted) throw new Error(`migration 317: ${target} was not replaced`);
  return { reinstalled: true };
}
