/**
 * Consolidating duplicate cuota plans folds each removed sibling's flow into the kept plan's: the
 * kept plan carries the sibling's note and the older arrival (`ccInstallmentDuplicateRepair.ts`).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "./db.js";
import { clearAggregationCache } from "./cacheRegistry.js";
import { createTempCardMaster, deleteTempCardMaster } from "./test/tempCardMaster.js";
import { snapshotTables } from "./test/snapshotTables.js";
import { repairAccountInstallmentDuplicates } from "./ccInstallmentDuplicateRepair.js";
import { flowArrival } from "./flows/flowFirstSeen.js";

const restoreDerived = snapshotTables(["valuations", "cc_owed_anchors", "cc_billing_month_metrics"]);

describe("consolidating duplicate installment plans", () => {
  let card = 0;
  beforeEach(() => {
    card = createTempCardMaster({ issuer: "santander", last4: "6464", key: "vitest-plan-dup" });
  });
  afterEach(() => {
    deleteTempCardMaster(card);
    db.prepare(`DELETE FROM flows WHERE from_account_id = ? OR to_account_id = ?`).run(card, card);
    restoreDerived();
    clearAggregationCache();
  });

  const plan = (canonical: string): number =>
    Number(
      db
        .prepare(
          `INSERT INTO cc_installment_purchases (account_id, card_group, canonical_row_id, purchase_date, total_amount_clp, cuotas_totales, merchant, description_merged, source)
           VALUES (?, 'santander', ?, '2026-04-10', 120000, 6, 'VITEST DUPPLAN', 'VITEST DUPPLAN', 'manual')`
        )
        .run(card, canonical).lastInsertRowid
    );
  const flowOf = (id: number) => (db.prepare(`SELECT flow_id FROM cc_installment_purchases WHERE id = ?`).get(id) as { flow_id: number }).flow_id;
  const exists = (id: number) => db.prepare(`SELECT 1 FROM cc_installment_purchases WHERE id = ?`).get(id) != null;

  it("the kept plan takes the removed sibling's note and older arrival; a dry run writes nothing", () => {
    const older = plan("vitest-dup-a"); // the sibling: lower id, removed
    const kept = plan("vitest-dup-b"); // the newer id stays
    db.prepare(`DELETE FROM flow_first_seen WHERE flow_id IN (?, ?)`).run(flowOf(older), flowOf(kept));
    db.prepare(`INSERT INTO flow_first_seen (flow_id, first_seen_on, first_seen_at, first_seen_seq) VALUES (?, '2026-04-10', NULL, NULL)`).run(flowOf(older));
    db.prepare(`INSERT INTO flow_first_seen (flow_id, first_seen_on, first_seen_at, first_seen_seq) VALUES (?, '2026-04-20', NULL, NULL)`).run(flowOf(kept));
    db.prepare(`INSERT INTO flow_notes (flow_id, portion, piece_seq, account_id, notes, updated_at) VALUES (?, 'gastos', -1, ?, 'filed on the first plan', datetime('now'))`).run(flowOf(older), card);

    expect(repairAccountInstallmentDuplicates(card, false).purchasesRemoved).toBe(1);
    expect(exists(older)).toBe(true);

    expect(repairAccountInstallmentDuplicates(card, true).purchasesRemoved).toBe(1);
    expect(exists(older)).toBe(false);
    const flow = flowOf(kept);
    expect((db.prepare(`SELECT notes FROM flow_notes WHERE flow_id = ?`).get(flow) as { notes: string } | undefined)?.notes).toBe("filed on the first plan");
    expect(flowArrival(flow)).toEqual({ kind: "stamped", stamp: expect.objectContaining({ on: "2026-04-10" }) });
  });
});
