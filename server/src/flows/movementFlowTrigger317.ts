import type { Database as DatabaseType } from "better-sqlite3";
import { currentFlowInsertTriggerSql } from "./flowTables279.js";
import { reinstallTableTriggersInOrder } from "../tableTriggerReinstall.js";

/**
 * Re-creates the movements flow-insert trigger (`flow_movements_ai`) from the current specs where it
 * differs, keeping every movements trigger in its creation order (`reinstallTableTriggersInOrder`).
 *
 * Migration 317: databases migrated before the options work (migration 304) carried it as migration
 * 290 last installed it, without the `option_*` flow kinds. Migration 318: the currency-neutral flow
 * kinds (`deposit`, `withdrawal`, `fx_exchange`, `fx_purchase`, …) replace the kinds named after a
 * currency in its kind CASE. A fresh database installs it from the current specs and is left as it
 * is. Pure: no `db` import.
 */
export function reinstallMovementFlowInsertTrigger(dbi: DatabaseType, label: string): { reinstalled: boolean } {
  const changed = reinstallTableTriggersInOrder(
    dbi,
    "movements",
    { flow_movements_ai: currentFlowInsertTriggerSql("movements") },
    label
  );
  return { reinstalled: changed.length > 0 };
}

export function runMovementFlowTrigger317(dbi: DatabaseType): { reinstalled: boolean } {
  return reinstallMovementFlowInsertTrigger(dbi, "migration 317");
}
