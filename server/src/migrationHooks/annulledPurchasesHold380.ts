import type { Database as DatabaseType } from "better-sqlite3";
import { FLOW_SOURCES } from "../flows/flowTriggerSpecs.js";
import { flowRetireDeleteTriggerSql } from "./flowRetirement290.js";
import { reinstallTableTriggersInOrder } from "./tableTriggerReinstall.js";

/**
 * Migration 380 hook: the flow delete triggers of every source table count an annulled card
 * purchase (`cc_annulled_purchases.flow_id`) as holding its flow, on top of migration 371's rules.
 * Pure (no `db` import — the module graph is still initializing).
 */
export function runAnnulledPurchasesHold380(dbi: DatabaseType): void {
  for (const spec of FLOW_SOURCES) {
    reinstallTableTriggersInOrder(
      dbi,
      spec.table,
      {
        [`flow_${spec.table}_ad`]: flowRetireDeleteTriggerSql(spec, { refundLinks: true, restatedEvidence: true, annulledPurchases: true }),
      },
      "migration 380"
    );
  }
}
