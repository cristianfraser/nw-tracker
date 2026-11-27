/**
 * Pruning a statement outright reports the lines that carry user-filed work, refuses them without
 * the explicit flag, and deletes through the card-line write funnel (`ccStatementPrune.ts`).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "./db.js";
import { clearAggregationCache } from "./cacheRegistry.js";
import { createTempCardMaster, deleteTempCardMaster } from "./test/tempCardMaster.js";
import { snapshotTables } from "./test/snapshotTables.js";
import { pruneStatements, reportStatementPrune } from "./ccStatementPrune.js";
import { resolveCcExpensePurchaseKey } from "./ccExpenseCategories.js";
import { setFlowNote } from "./flows/flowNotes.js";

const restoreDerived = snapshotTables(["valuations", "cc_owed_anchors", "cc_billing_month_metrics"]);

describe("pruning statements without a PDF", () => {
  let card = 0;
  let plain = 0;
  let filed = 0;

  const statement = (tag: string) =>
    Number(
      db
        .prepare(
          `INSERT INTO cc_statements (account_id, card_group, source_pdf, statement_date, card_last4, layout, currency)
           VALUES (?, 'santander', ?, '24/05/2026', '6363', 'compact', 'clp')`
        )
        .run(card, `vitest-prune-${tag}.pdf`).lastInsertRowid
    );
  const line = (statementId: number, tag: string) =>
    Number(
      db
        .prepare(
          `INSERT INTO cc_statement_lines (statement_id, transaction_date, merchant, amount, currency, installment_flag, dedupe_key, parser_row_id, raw_line)
           VALUES (?, '05/05/2026', ?, 9000, 'clp', 0, ?, ?, 'raw')`
        )
        .run(statementId, `VITEST PRUNE ${tag}`, `vitest-prune-${tag}`, `vitest-prune-row-${tag}`).lastInsertRowid
    );
  const statementExists = (id: number) => db.prepare(`SELECT 1 FROM cc_statements WHERE id = ?`).get(id) != null;

  beforeEach(() => {
    card = createTempCardMaster({ issuer: "santander", last4: "6363", key: "vitest-prune" });
    plain = statement("plain");
    filed = statement("filed");
    line(plain, "p1");
    const withNote = line(filed, "f1");
    line(filed, "f2");
    setFlowNote(card, resolveCcExpensePurchaseKey(withNote), "filed by hand");
  });
  afterEach(() => {
    deleteTempCardMaster(card);
    db.prepare(`DELETE FROM flows WHERE from_account_id = ? OR to_account_id = ?`).run(card, card);
    restoreDerived();
    clearAggregationCache();
  });

  it("counts the lines that carry filed assignments, per statement", () => {
    expect(reportStatementPrune([plain, filed])).toEqual([
      { statementId: plain, accountId: card, lines: 1, lines_with_assignments: 0 },
      { statementId: filed, accountId: card, lines: 2, lines_with_assignments: 1 },
    ]);
  });

  it("refuses a statement with assignments, writing nothing, unless told to", () => {
    expect(() => pruneStatements([plain, filed], { allowAssignmentLoss: false })).toThrow(/statement \d+ \(1 line/);
    expect(statementExists(plain)).toBe(true);
    expect(statementExists(filed)).toBe(true);
    pruneStatements([plain, filed], { allowAssignmentLoss: true });
    expect(statementExists(plain)).toBe(false);
    expect(statementExists(filed)).toBe(false);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM cc_statement_lines WHERE statement_id IN (?, ?)`).get(plain, filed)).toEqual({ n: 0 });
  });

  it("prunes a statement with nothing filed with no flag", () => {
    pruneStatements([plain], { allowAssignmentLoss: false });
    expect(statementExists(plain)).toBe(false);
    expect(statementExists(filed)).toBe(true);
  });
});
