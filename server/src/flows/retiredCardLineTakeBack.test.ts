import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "../db.js";
import { chileCalendarTodayYmd } from "../chileDate.js";
import { snapshotTables } from "../test/snapshotTables.js";
import { createTempCardMaster, deleteTempCardMaster } from "../test/tempCardMaster.js";
import { cardLineWrite, deleteLines, insertLines } from "../cards/lineWrites.js";
import { resolveCcExpensePurchaseKey } from "../ccExpenseCategories.js";
import { setFlowNote } from "./flowNotes.js";
import { flowArrival, maxFirstSeenSeq } from "./flowFirstSeen.js";
import { markAnnulledPurchaseManually, undoManualAnnulledPurchase } from "../ccAnnulledPurchaseManual.js";
import { findRelistedAnnulments, lastCardLineId, settleRelistedAnnulments } from "../ccAnnulmentWriters.js";
import type { CcListingLine } from "../ccWebPasteParse.js";
import { expenseKeyParts } from "./flowKeyResolve.js";

/**
 * A card line written as a new arrival under the document key of a line this card deleted takes the
 * deleted line's retired flow back (`takeBackRetiredCardLineFlow`): its note and arrival with it.
 */
const restoreDerivedCardState = snapshotTables(["valuations", "cc_owed_anchors", "cc_billing_month_metrics"]);
afterAll(() => restoreDerivedCardState());

describe("a card line takes back the flow retired with its document", () => {
  let accountId = 0;
  const today = chileCalendarTodayYmd();

  const row = (merchant: string, amount: number): CcListingLine => ({
    transaction_date: today,
    merchant,
    currency: "clp",
    amount,
    raw_line: merchant,
  });
  const list = (merchant: string, amount: number, n = 1) =>
    insertLines(accountId, { lines: Array.from({ length: n }, () => row(merchant, amount)), errors: [] });

  const lineIds = (merchant: string): number[] =>
    (
      db
        .prepare(
          `SELECT l.id FROM cc_statement_lines l JOIN cc_statements s ON s.id = l.statement_id
           WHERE s.account_id = ? AND l.merchant = ? ORDER BY l.id`
        )
        .all(accountId, merchant) as { id: number }[]
    ).map((r) => r.id);
  const flowOf = (lineId: number) =>
    (db.prepare(`SELECT flow_id FROM cc_statement_lines WHERE id = ?`).get(lineId) as { flow_id: number }).flow_id;
  const notesOn = (flowId: number) =>
    (db.prepare(`SELECT notes FROM flow_notes WHERE flow_id = ?`).all(flowId) as { notes: string }[]).map((r) => r.notes);
  const retired = (flowId: number) =>
    db.prepare(`SELECT retired_on IS NOT NULL AS retired, retired_document_key FROM flows WHERE id = ?`).get(flowId) as
      | { retired: number; retired_document_key: string | null }
      | undefined;
  const annotate = (lineId: number, note: string) => setFlowNote(accountId, resolveCcExpensePurchaseKey(lineId), note);

  let placeId = 0;
  /** A real-estate bill linked to the flow (a `bill` flow link: one per flow, one per bill). */
  const linkBill = (flowId: number) => {
    if (placeId === 0) {
      const group = Number(db.prepare(`INSERT INTO expense_groups (slug, label) VALUES ('vitest-takeback-place', 'vitest')`).run().lastInsertRowid);
      placeId = Number(db.prepare(`INSERT INTO expense_accounts (group_id, slug, label) VALUES (?, 'vitest-takeback', 'vitest')`).run(group).lastInsertRowid);
    }
    const bill = Number(
      db.prepare(`INSERT INTO expense_entries (amount, currency, spent_on, category, expense_account_id) VALUES (1000, 'clp', ?, 'rent', ?)`).run(today, placeId)
        .lastInsertRowid
    );
    db.prepare(`INSERT INTO flow_links (flow_id, kind, counterpart_entry_id, link_source) VALUES (?, 'bill', ?, 'manual')`).run(flowId, bill);
    return bill;
  };
  const billsOn = (flowId: number) =>
    (db.prepare(`SELECT counterpart_entry_id AS bill FROM flow_links WHERE flow_id = ? AND kind = 'bill'`).all(flowId) as { bill: number }[]).map((r) => r.bill);
  /** A copy of `flowId` (its columns), retired or not, answering to `legacyKey`. */
  const copyFlow = (flowId: number, opts: { retired: boolean; legacyKey: string | null }) =>
    Number(
      db
        .prepare(
          `INSERT INTO flows (kind, from_account_id, to_account_id, from_party_id, to_party_id, occurred_on, amount, currency,
             description, legacy_key, retired_on, retired_source_table, retired_document_key)
           SELECT kind, from_account_id, to_account_id, from_party_id, to_party_id, occurred_on, amount, currency, description, ?,
             ${opts.retired ? "retired_on, retired_source_table, retired_document_key" : "NULL, NULL, NULL"} FROM flows WHERE id = ?`
        )
        .run(opts.legacyKey, flowId).lastInsertRowid
    );

  beforeEach(() => {
    accountId = createTempCardMaster({ issuer: "santander", last4: "7741", key: "vitest-retired-take-back" });
  });
  afterEach(() => {
    db.prepare(`DELETE FROM flows WHERE from_account_id = ? OR to_account_id = ?`).run(accountId, accountId);
    deleteTempCardMaster(accountId);
    if (placeId !== 0) {
      db.prepare(`DELETE FROM expense_entries WHERE expense_account_id = ?`).run(placeId);
      db.prepare(`DELETE FROM expense_accounts WHERE id = ?`).run(placeId);
      db.prepare(`DELETE FROM expense_groups WHERE slug = 'vitest-takeback-place'`).run();
      placeId = 0;
    }
  });

  it("a line deleted with a note and listed again is the same flow: note and arrival come back", () => {
    list("VITEST TAKEBACK SHOP", 12_340);
    const [first] = lineIds("VITEST TAKEBACK SHOP");
    annotate(first!, "vitest: filed on the first listing");
    const flow = flowOf(first!);
    const arrival = flowArrival(flow);
    expect(arrival.kind).toBe("stamped");
    deleteLines(accountId, [first!], { what: "vitest: deleted by hand" });
    expect(retired(flow)?.retired).toBe(1);

    const result = list("VITEST TAKEBACK SHOP", 12_340);
    const [again] = lineIds("VITEST TAKEBACK SHOP");
    // (Line ids are reused: the row may carry the old id; its flow is what says it is the same purchase.)
    expect(flowOf(again!)).toBe(flow);
    expect(notesOn(flow)).toEqual(["vitest: filed on the first listing"]);
    expect(flowArrival(flow)).toEqual(arrival);
    expect(retired(flow)?.retired).toBe(0);
    expect(result.retired_flows_taken_back).toEqual([
      expect.objectContaining({ line_id: again, status: "adopted", flow_ids: [flow], reason: null }),
    ]);
  });

  it("two flows retired with the document: nothing is taken, and it is reported", () => {
    list("VITEST TAKEBACK TWO", 5_550);
    const [first] = lineIds("VITEST TAKEBACK TWO");
    annotate(first!, "vitest: one");
    const flow = flowOf(first!);
    deleteLines(accountId, [first!], { what: "vitest: deleted by hand" });
    const doc = retired(flow)!.retired_document_key;
    expect(doc).not.toBeNull();
    // A second incarnation of the same document, retired too.
    const other = Number(
      db
        .prepare(
          `INSERT INTO flows (kind, from_account_id, to_account_id, from_party_id, to_party_id, occurred_on, amount, currency,
             description, retired_on, retired_source_table, retired_document_key)
           SELECT kind, from_account_id, to_account_id, from_party_id, to_party_id, occurred_on, amount, currency,
             description, retired_on, retired_source_table, retired_document_key FROM flows WHERE id = ?`
        )
        .run(flow).lastInsertRowid
    );

    const result = list("VITEST TAKEBACK TWO", 5_550);
    const [again] = lineIds("VITEST TAKEBACK TWO");
    expect([flow, other]).not.toContain(flowOf(again!));
    expect(retired(flow)?.retired).toBe(1);
    expect(retired(other)?.retired).toBe(1);
    expect(result.retired_flows_taken_back).toEqual([
      expect.objectContaining({ line_id: again, status: "ambiguous", flow_ids: [flow, other].sort((a, b) => a - b) }),
    ]);
  });

  it("an unkeyed retired flow held only by a bill link comes back: flow, arrival, link", () => {
    list("VITEST TAKEBACK BILL", 8_880);
    const [first] = lineIds("VITEST TAKEBACK BILL");
    const flow = flowOf(first!);
    const arrival = flowArrival(flow);
    expect(arrival.kind).toBe("stamped");
    const bill = linkBill(flow);
    deleteLines(accountId, [first!], { what: "vitest: deleted by hand" });
    expect(db.prepare(`SELECT retired_on IS NOT NULL AS retired, legacy_key FROM flows WHERE id = ?`).get(flow)).toEqual({ retired: 1, legacy_key: null });

    const result = list("VITEST TAKEBACK BILL", 8_880);
    const [again] = lineIds("VITEST TAKEBACK BILL");
    expect(flowOf(again!)).toBe(flow);
    expect(flowArrival(flow)).toEqual(arrival);
    expect(billsOn(flow)).toEqual([bill]);
    expect(result.retired_flows_taken_back).toEqual([expect.objectContaining({ line_id: again, status: "adopted" })]);
  });

  it("refused, nothing written, when a third flow holding the line's key carries a bill link too", () => {
    list("VITEST TAKEBACK HOLDER", 9_990);
    const [first] = lineIds("VITEST TAKEBACK HOLDER");
    const key = expenseKeyParts(resolveCcExpensePurchaseKey(first!))!.flowKey;
    const flow = flowOf(first!);
    const billA = linkBill(flow);
    deleteLines(accountId, [first!], { what: "vitest: deleted by hand" });
    // Another flow answers to the line's key and holds a bill of its own: the adoption would fold it in.
    const holder = copyFlow(flow, { retired: false, legacyKey: key });
    const billB = linkBill(holder);

    const result = list("VITEST TAKEBACK HOLDER", 9_990);
    const [again] = lineIds("VITEST TAKEBACK HOLDER");
    expect([flow, holder]).not.toContain(flowOf(again!));
    expect(result.retired_flows_taken_back).toEqual([
      expect.objectContaining({ line_id: again, status: "refused", reason: expect.stringMatching(/flow_links/) }),
    ]);
    expect(retired(flow)?.retired).toBe(1);
    expect(billsOn(flow)).toEqual([billA]);
    expect(billsOn(holder)).toEqual([billB]);
  });

  it("a re-listed annulment keeps its flow for the settle step: an earlier incarnation is not taken first", () => {
    list("VITEST TAKEBACK RELIST", 2_220);
    const [first] = lineIds("VITEST TAKEBACK RELIST");
    const category = (db.prepare(`SELECT id FROM cc_expense_categories ORDER BY id LIMIT 1`).get() as { id: number }).id;
    db.prepare(`INSERT INTO flow_refunds (flow_id, category_id) VALUES (?, ?)`).run(flowOf(first!), category);
    const annulment = markAnnulledPurchaseManually(accountId, first!, today);
    // An earlier incarnation of the same document, retired with a refund mark of its own.
    const earlier = copyFlow(annulment.flow_id!, { retired: true, legacyKey: null });
    db.prepare(`INSERT INTO flow_refunds (flow_id, category_id) VALUES (?, ?)`).run(earlier, category);

    const lines = [row("VITEST TAKEBACK RELIST", 2_220)];
    cardLineWrite(accountId, "vitest: a listing re-lists the purchase", () => {
      const pending = findRelistedAnnulments(accountId, lines);
      const lastLineIdBefore = lastCardLineId();
      const since = maxFirstSeenSeq();
      const result = insertLines(accountId, { lines, errors: [] });
      expect(result.retired_flows_taken_back).toEqual([
        expect.objectContaining({ status: "refused", reason: expect.stringMatching(/annulled purchase/) }),
      ]);
      expect(settleRelistedAnnulments(accountId, pending, lastLineIdBefore, since)).toEqual([expect.objectContaining({ outcome: "line" })]);
    });
    const [listed] = lineIds("VITEST TAKEBACK RELIST");
    expect(flowOf(listed!)).toBe(annulment.flow_id);
    expect(retired(earlier)?.retired).toBe(1);
  });

  it("never takes the flow a standing annulment holds", () => {
    list("VITEST TAKEBACK ANNUL", 7_770);
    const [first] = lineIds("VITEST TAKEBACK ANNUL");
    annotate(first!, "vitest: the voided purchase");
    const annulment = markAnnulledPurchaseManually(accountId, first!, today);
    const held = annulment.flow_id!;
    // It is retired with the line's document: only the annulment keeps it from being taken.
    expect(retired(held)).toEqual({ retired: 1, retired_document_key: expect.any(String) });

    const result = list("VITEST TAKEBACK ANNUL", 7_770);
    const [listed] = lineIds("VITEST TAKEBACK ANNUL");
    expect(flowOf(listed!)).not.toBe(held);
    expect(retired(held)?.retired).toBe(1);
    expect(result.retired_flows_taken_back).toEqual([]);
  });

  it("a twin takes back its own flow, never its sibling's", () => {
    list("VITEST TAKEBACK TWIN", 3_300, 2);
    const [a, b] = lineIds("VITEST TAKEBACK TWIN");
    annotate(a!, "vitest: twin one");
    annotate(b!, "vitest: twin two");
    const [flowA, flowB] = [flowOf(a!), flowOf(b!)];
    deleteLines(accountId, [a!, b!], { what: "vitest: deleted by hand" });
    expect(retired(flowA)!.retired_document_key).not.toBe(retired(flowB)!.retired_document_key);

    list("VITEST TAKEBACK TWIN", 3_300, 2);
    const back = lineIds("VITEST TAKEBACK TWIN");
    const byKey = new Map(
      back.map((id) => [(db.prepare(`SELECT dedupe_key FROM cc_statement_lines WHERE id = ?`).get(id) as { dedupe_key: string }).dedupe_key, id])
    );
    const firstKey = [...byKey.keys()].find((k) => !k.includes("#dup"))!;
    expect(flowOf(byKey.get(firstKey)!)).toBe(flowA);
    expect(flowOf(byKey.get(`${firstKey}#dup1`)!)).toBe(flowB);
    expect(notesOn(flowA)).toEqual(["vitest: twin one"]);
    expect(notesOn(flowB)).toEqual(["vitest: twin two"]);
  });
});

describe("an annulment whose flow is gone (recorded before migration 380)", () => {
  let accountId = 0;
  const today = chileCalendarTodayYmd();
  const row = (merchant: string, amount: number): CcListingLine => ({ transaction_date: today, merchant, currency: "clp", amount, raw_line: merchant });
  const lineOf = (merchant: string) =>
    db
      .prepare(
        `SELECT l.id, l.flow_id FROM cc_statement_lines l JOIN cc_statements s ON s.id = l.statement_id WHERE s.account_id = ? AND l.merchant = ?`
      )
      .get(accountId, merchant) as { id: number; flow_id: number };

  /** An annulled purchase as migration 380 found it: its flow deleted with its line. */
  function flowlessAnnulment(merchant: string, amount: number) {
    insertLines(accountId, { lines: [row(merchant, amount)], errors: [] });
    const a = markAnnulledPurchaseManually(accountId, lineOf(merchant).id, today);
    db.prepare(`UPDATE cc_annulled_purchases SET flow_id = NULL WHERE id = ?`).run(a.id);
    db.prepare(`DELETE FROM flows WHERE id = ?`).run(a.flow_id);
    return a;
  }

  beforeEach(() => {
    accountId = createTempCardMaster({ issuer: "santander", last4: "7742", key: "vitest-flowless-annulment" });
  });
  afterEach(() => {
    db.prepare(`DELETE FROM flows WHERE from_account_id = ? OR to_account_id = ?`).run(accountId, accountId);
    deleteTempCardMaster(accountId);
  });

  it("re-listed by the bank: the line it stands for is no new arrival", () => {
    flowlessAnnulment("VITEST FLOWLESS RELIST", 4_440);
    const lines = [row("VITEST FLOWLESS RELIST", 4_440)];
    cardLineWrite(accountId, "vitest: a listing re-lists the purchase", () => {
      const pending = findRelistedAnnulments(accountId, lines);
      expect(pending).toHaveLength(1);
      const lastLineIdBefore = lastCardLineId();
      const since = maxFirstSeenSeq();
      insertLines(accountId, { lines, errors: [] });
      expect(settleRelistedAnnulments(accountId, pending, lastLineIdBefore, since)).toEqual([
        expect.objectContaining({ outcome: "line" }),
      ]);
    });
    expect(flowArrival(lineOf("VITEST FLOWLESS RELIST").flow_id)).toEqual({ kind: "before_stamps" });
  });

  it("undone by hand: the re-listed line is no new arrival", () => {
    const a = flowlessAnnulment("VITEST FLOWLESS UNDO", 6_660);
    undoManualAnnulledPurchase(accountId, a.id);
    expect(flowArrival(lineOf("VITEST FLOWLESS UNDO").flow_id)).toEqual({ kind: "before_stamps" });
  });
});
