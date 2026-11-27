/**
 * A display duplicate removed for good folds into the kept twin: the survivor keeps the
 * duplicate's note and big group and the older arrival (`ccDuplicateExpenseLineRemoval.ts`).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "./db.js";
import { clearAggregationCache } from "./cacheRegistry.js";
import { createTempCardMaster, deleteTempCardMaster } from "./test/tempCardMaster.js";
import { snapshotTables } from "./test/snapshotTables.js";
import { planDuplicateExpenseLineFolds, removeDuplicateExpenseLines } from "./ccDuplicateExpenseLineRemoval.js";
import type { CcExpenseLineForDedupe } from "./ccExpenseLineDedupe.js";
import { resolveCcExpensePurchaseKey } from "./ccExpenseCategories.js";
import { setFlowNote } from "./flows/flowNotes.js";
import { createCcExpenseBigGroup, deleteCcExpenseBigGroup, setCcExpensePurchaseBigGroup } from "./ccExpenseBigGroups.js";
import { flowArrival } from "./flows/flowFirstSeen.js";

const restoreDerived = snapshotTables(["valuations", "cc_owed_anchors", "cc_billing_month_metrics"]);

describe("folding display-duplicate card lines into their kept twin", () => {
  let card = 0;
  let bucket = 0;
  let group = "";

  beforeEach(() => {
    card = createTempCardMaster({ issuer: "santander", last4: "6262", key: "vitest-dup-fold" });
    bucket = Number(
      db
        .prepare(
          `INSERT INTO cc_statements (account_id, card_group, source_pdf, statement_date, card_last4, layout, currency)
           VALUES (?, 'santander', 'import:web-paste|open|2026-05', '20/05/2026', '6262', 'compact', 'clp')`
        )
        .run(card).lastInsertRowid
    );
    group = createCcExpenseBigGroup(`VITEST DUPFOLD ${Date.now()}`).slug;
  });
  afterEach(() => {
    deleteTempCardMaster(card);
    db.prepare(`DELETE FROM flows WHERE from_account_id = ? OR to_account_id = ?`).run(card, card);
    deleteCcExpenseBigGroup(group);
    restoreDerived();
    clearAggregationCache();
  });

  const line = (merchant: string, tag: string): number =>
    Number(
      db
        .prepare(
          `INSERT INTO cc_statement_lines (statement_id, transaction_date, merchant, amount, currency, installment_flag, dedupe_key, parser_row_id, raw_line)
           VALUES (?, '05/05/2026', ?, 12000, 'clp', 0, ?, ?, 'raw')`
        )
        .run(bucket, merchant, `vitest-dup-${tag}`, `web:vitest-dup-${tag}`).lastInsertRowid
    );
  const flowOf = (id: number) => (db.prepare(`SELECT flow_id FROM cc_statement_lines WHERE id = ?`).get(id) as { flow_id: number }).flow_id;
  const dedupeRecord = (id: number): CcExpenseLineForDedupe => ({
    account_id: card,
    merchant_key: "vitest dupshop",
    amount_clp: 12000,
    purchase_on: "2026-05-05",
    billing_month: "2026-05",
    installment_flag: 0,
    nro_cuota_current: null,
    nro_cuota_total: null,
    statement_line_id: id,
    category_slug: "unclassified",
    category_unique: false,
  });

  it("the kept twin takes the duplicate's note, big group and older arrival", () => {
    const first = line("VITEST DUPSHOP", "a"); // the earlier row, where the user filed their work
    const second = line("VITEST DUPSHOP SPA", "b"); // the preferred twin (higher id)
    db.prepare(`INSERT INTO flow_first_seen (flow_id, first_seen_on, first_seen_at, first_seen_seq) VALUES (?, '2026-05-05', NULL, NULL)`).run(flowOf(first));
    db.prepare(`INSERT INTO flow_first_seen (flow_id, first_seen_on, first_seen_at, first_seen_seq) VALUES (?, '2026-05-09', NULL, NULL)`).run(flowOf(second));
    const firstKey = resolveCcExpensePurchaseKey(first);
    const secondKey = resolveCcExpensePurchaseKey(second);
    expect(firstKey).not.toBe(secondKey);
    setFlowNote(card, firstKey, "filed on the first rendering");
    setCcExpensePurchaseBigGroup({ purchaseKey: firstKey, groupSlug: group });

    // The planner drops `first` (lower id, same score) and pairs it with `second`.
    const plan = planDuplicateExpenseLineFolds([dedupeRecord(first), dedupeRecord(second)]);
    expect(plan.folds).toEqual([{ accountId: card, fromLineId: first, intoLineId: second }]);
    expect(plan.unfoldable).toEqual([]);

    expect(removeDuplicateExpenseLines(plan.folds)).toBe(1);
    expect(db.prepare(`SELECT 1 FROM cc_statement_lines WHERE id = ?`).get(first)).toBeUndefined();
    const kept = flowOf(second);
    expect((db.prepare(`SELECT notes FROM flow_notes WHERE flow_id = ?`).get(kept) as { notes: string } | undefined)?.notes).toBe("filed on the first rendering");
    expect(db.prepare(`SELECT 1 FROM flow_big_groups WHERE flow_id = ?`).get(kept)).toBeDefined();
    expect(flowArrival(flowOf(second))).toEqual({ kind: "stamped", stamp: expect.objectContaining({ on: "2026-05-05" }) });
  });

  it("a duplicate of a synthetic plan line is reported and left alone", () => {
    const real = line("VITEST DUPSHOP", "c");
    const plan = planDuplicateExpenseLineFolds([dedupeRecord(real), { ...dedupeRecord(-5), category_slug: "supermarket" }]);
    expect(plan.folds).toEqual([]);
    expect(plan.unfoldable).toEqual([real]);
  });
});
