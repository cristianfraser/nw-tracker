/**
 * A duplicate-download statement removed by hand-over: its lines' flows go to the real
 * statement's lines (a line the document still needs moves as it is, a line already there takes
 * the copy line's flow by fold) before the copy goes (`ccDuplicateDownloadCopies.ts`).
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { cardStatementKey } from "nw-tracker-contracts";
import { db } from "./db.js";
import { clearAggregationCache } from "./cacheRegistry.js";
import { replaceStatementLines } from "./cards/lineWrites.js";
import { statementKeysOf } from "./ccInstallmentLedgerMerge.js";
import { parsedStatements, type ParsedRecord } from "./test/parsedStatementRecords.js";
import { snapshotTables } from "./test/snapshotTables.js";
import { createTempCardMaster, deleteTempCardMaster } from "./test/tempCardMaster.js";
import {
  assertMovedLinesSurvive,
  copyLinesWithAssignments,
  documentIdentityCounts,
  planCopyLineHandover,
  removeDuplicateDownloadCopies,
  storedStatementLines,
} from "./ccDuplicateDownloadCopies.js";
import { flowArrival } from "./flows/flowFirstSeen.js";

const restoreDerived = snapshotTables(["valuations", "cc_owed_anchors", "cc_billing_month_metrics"]);
afterAll(() => restoreDerived());

describe("removing a duplicate-download statement", () => {
  let card = 0;
  beforeEach(() => {
    card = createTempCardMaster({ issuer: "santander", last4: "6565", key: "vitest-dup-download" });
  });
  afterEach(() => {
    deleteTempCardMaster(card);
    db.prepare(`DELETE FROM flows WHERE from_account_id = ? OR to_account_id = ?`).run(card, card);
    restoreDerived();
    clearAggregationCache();
  });

  const row = (tag: string, merchant: string, day: string, amount: number): ParsedRecord => ({
    card_group: "santander",
    source_pdf: "vitest-dupdl-2026-05-22 clp.pdf",
    statement_date: "22/05/2026",
    period_from: "23/04/2026",
    period_to: "22/05/2026",
    card_last4: "6565",
    parser_layout: "compact",
    row_id: `vitest-dupdl-${tag}`,
    canonical_row_id: `vitest-dupdl-${tag}`,
    dedupe_key: `vitest-dupdl-${tag}`,
    transaction_date: day,
    merchant,
    amount_clp: String(amount),
    raw_line: `${day} ${merchant} ${amount}`,
    installment_flag: "false",
  });
  const statementId = (source: string) =>
    (db.prepare(`SELECT id FROM cc_statements WHERE account_id = ? AND source_pdf = ?`).get(card, source) as { id: number }).id;
  const copyLine = (copyId: number, merchant: string, day: string, amount: number, tag: string): number =>
    Number(
      db
        .prepare(
          `INSERT INTO cc_statement_lines (statement_id, transaction_date, merchant, amount, currency, installment_flag, dedupe_key, parser_row_id, raw_line)
           VALUES (?, ?, ?, ?, 'clp', 0, ?, ?, 'raw')`
        )
        .run(copyId, day, merchant, amount, `vitest-copy-${tag}`, `vitest-copy-row-${tag}`).lastInsertRowid
    );
  const flowOf = (id: number) => (db.prepare(`SELECT flow_id FROM cc_statement_lines WHERE id = ?`).get(id) as { flow_id: number }).flow_id;
  const note = (flow: number) => (db.prepare(`SELECT notes FROM flow_notes WHERE flow_id = ?`).get(flow) as { notes: string } | undefined)?.notes;
  const stamp = (lineId: number, on: string) => {
    db.prepare(`DELETE FROM flow_first_seen WHERE flow_id = ?`).run(flowOf(lineId));
    db.prepare(`INSERT INTO flow_first_seen (flow_id, first_seen_on, first_seen_at, first_seen_seq) VALUES (?, ?, NULL, NULL)`).run(flowOf(lineId), on);
  };
  const fileNote = (lineId: number, text: string) =>
    db.prepare(`INSERT INTO flow_notes (flow_id, portion, piece_seq, account_id, notes, updated_at) VALUES (?, 'gastos', -1, ?, ?, datetime('now'))`).run(flowOf(lineId), card, text);

  it("each copy line hands its note and older arrival to the real statement's line", () => {
    // The real statement as the old import left it: only line A is on file.
    const partial = parsedStatements([row("a", "VITEST SHOP ONE", "05/05/26", 11_000)]);
    replaceStatementLines(card, partial, { replaceStatementKeys: statementKeysOf(partial) });
    const full = parsedStatements([row("a", "VITEST SHOP ONE", "05/05/26", 11_000), row("b", "VITEST SHOP TWO", "06/05/26", 22_000)]);
    const target = full[0]!;
    const targetId = statementId(target.document);
    const targetLineA = storedStatementLines(targetId)[0]!;
    stamp(targetLineA.id, "2026-05-30");

    // The phantom copy: both lines, filed on by hand, seen first.
    const copyId = Number(
      db
        .prepare(
          `INSERT INTO cc_statements (account_id, card_group, source_pdf, statement_date, period_from, period_to, card_last4, layout, currency)
           VALUES (?, 'santander', 'vitest-dupdl-copy.pdf', '10/06/2026', '22/05/2026', '10/06/2026', '6565', 'compact', 'clp')`
        )
        .run(card).lastInsertRowid
    );
    const copyA = copyLine(copyId, "VITEST SHOP ONE", "05/05/2026", 11_000, "a");
    const copyB = copyLine(copyId, "VITEST SHOP TWO", "06/05/2026", 22_000, "b");
    stamp(copyA, "2026-05-06");
    stamp(copyB, "2026-05-07");
    fileNote(copyA, "note on A");
    fileNote(copyB, "note on B");
    expect(copyLinesWithAssignments(storedStatementLines(copyId))).toEqual([copyA, copyB]);

    const handover = planCopyLineHandover("clp", storedStatementLines(copyId), storedStatementLines(targetId), documentIdentityCounts(target));
    expect(handover).toEqual({ move: [copyB], fold: [{ fromLineId: copyA, intoLineId: targetLineA.id }] });

    removeDuplicateDownloadCopies(card, [
      { copyStatementId: copyId, targetStatementId: targetId, currency: "clp", targetStatement: target, targetKey: cardStatementKey(target) },
    ]);

    expect(db.prepare(`SELECT 1 FROM cc_statements WHERE id = ?`).get(copyId)).toBeUndefined();
    // A: the fold. B: the very line the copy held, restated by the import.
    expect(note(flowOf(targetLineA.id))).toBe("note on A");
    expect(flowArrival(flowOf(targetLineA.id))).toEqual({ kind: "stamped", stamp: expect.objectContaining({ on: "2026-05-06" }) });
    const lines = storedStatementLines(targetId);
    expect(lines.map((l) => l.id)).toContain(copyB);
    expect(lines).toHaveLength(2);
    expect(note(flowOf(copyB))).toBe("note on B");
    expect(flowArrival(flowOf(copyB))).toEqual({ kind: "stamped", stamp: expect.objectContaining({ on: "2026-05-07" }) });
  });

  it("fails when a moved line is no longer on the real statement under its flow", () => {
    const partial = parsedStatements([row("a", "VITEST SHOP ONE", "05/05/26", 11_000)]);
    replaceStatementLines(card, partial, { replaceStatementKeys: statementKeysOf(partial) });
    const targetId = statementId(partial[0]!.document);
    const line = storedStatementLines(targetId)[0]!;
    const flow = flowOf(line.id);
    expect(() => assertMovedLinesSurvive(new Map([[line.id, flow]]), targetId)).not.toThrow();
    // Written again under another flow (what an unpaired line does in the import).
    expect(() => assertMovedLinesSurvive(new Map([[line.id, flow + 1_000_000]]), targetId)).toThrow(/did not restate moved line/);
    db.prepare(`DELETE FROM cc_statement_lines WHERE id = ?`).run(line.id);
    expect(() => assertMovedLinesSurvive(new Map([[line.id, flow]]), targetId)).toThrow(/did not restate moved line/);
  });
});
