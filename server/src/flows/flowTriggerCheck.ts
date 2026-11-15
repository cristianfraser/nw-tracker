import type { Database as DatabaseType } from "better-sqlite3";
import { currentFlowInsertTriggerSql } from "./flowTriggerSpecs.js";

const TRIGGER = "flow_movements_ai";

/**
 * Boot check, run by `db.ts` right after the migrations: the movements flow-insert trigger
 * installed in the database must be the one the current code specifies
 * (`currentFlowInsertTriggerSql("movements")`). Its kind CASE is built from the contracts'
 * `LEGACY_FLOW_KIND_MAP`, so a flow kind added there without a migration leaves every migrated
 * database with a trigger that files the new kind's movements under the wrong flow kind (migrations
 * 317 and 318 exist because that happened). The texts are compared as stored, byte for byte — the
 * comparison `reinstallTableTriggersInOrder` makes, so a trigger it would leave alone passes.
 *
 * Fails fast and repairs nothing: the fix is a migration, so every database gets it once and in order.
 * Pure: no `db` import (it loads with `db.ts`).
 */
export function assertMovementFlowTriggerCurrent(dbi: DatabaseType): void {
  const installed = dbi
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'movements' AND name = ?`)
    .get(TRIGGER) as { sql: string } | undefined;
  const fix =
    `Add a migration whose hook calls reinstallMovementFlowInsertTrigger(dbi, "migration <n>") ` +
    `(server/src/migrationHooks/movementFlowTrigger317.ts; migration 317 is the example) and restart.`;
  if (!installed) {
    throw new Error(`Boot check: the movements table has no ${TRIGGER} trigger, so new movements would get no flow. ${fix}`);
  }
  const expected = currentFlowInsertTriggerSql("movements");
  if (installed.sql === expected) return;
  throw new Error(
    `Boot check: the installed ${TRIGGER} trigger is not the one the code specifies ` +
      `(flows/flowTriggerSpecs.ts; first difference at character ${firstDifference(installed.sql, expected)}: ` +
      `installed «${excerpt(installed.sql, expected)}», expected «${excerpt(expected, installed.sql)}»). ` +
      `Movements written through a stale trigger get the wrong flow kind. ${fix}`
  );
}

function firstDifference(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  return i;
}

function excerpt(text: string, other: string): string {
  const at = firstDifference(text, other);
  return text.slice(Math.max(0, at - 20), at + 60).replace(/\s+/g, " ");
}
