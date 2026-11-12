import { afterAll, describe, expect, it } from "vitest";
import { snapshotTables } from "./test/snapshotTables.js";
import { db } from "./db.js";
import { deleteCcWebPasteStatementLine } from "./ccStatementLineDelete.js";
import { listCcStatementsForAccount } from "./ccStatementsDb.js";

// Card writes here re-stamp the owed walk; put every card's marks, anchors and billing snapshots back.
const restoreDerivedCardState = snapshotTables(["valuations", "cc_owed_anchors", "cc_billing_month_balances"]);
afterAll(() => restoreDerivedCardState());

describe("deleteCcWebPasteStatementLine", () => {
  it("deletes a web-paste line and rejects PDF lines", () => {
    const master = db
      .prepare(`SELECT id FROM accounts WHERE import_key = 'credit_card_master|santander|4321'`)
      .get() as { id: number };

    const webPasteStmt = listCcStatementsForAccount(master.id).find((s) => s.source_kind === "listing_open");
    if (!webPasteStmt) throw new Error("the Vitest person's card has no open listing");

    // A line of our own in the open bucket: deleting one of the person's lines would change the
    // card every later file reads.
    const line = {
      id: Number(
        db
          .prepare(
            `INSERT INTO cc_statement_lines (statement_id, transaction_date, merchant, amount, installment_flag, dedupe_key)
             VALUES (?, ?, 'VITEST LINE DELETE', 1234, 0, 'vitest-line-delete')`
          )
          .run(webPasteStmt.id, webPasteStmt.statement_date).lastInsertRowid
      ),
    };

    const before = db
      .prepare(`SELECT COUNT(*) AS c FROM cc_statement_lines WHERE statement_id = ?`)
      .get(webPasteStmt.id) as { c: number };

    const result = deleteCcWebPasteStatementLine(master.id, line.id);
    expect(result.removed_count).toBe(1);

    const after = db
      .prepare(`SELECT COUNT(*) AS c FROM cc_statement_lines WHERE statement_id = ?`)
      .get(webPasteStmt.id) as { c: number };
    expect(after.c).toBe(before.c - 1);

    const pdfStmt = listCcStatementsForAccount(master.id).find(
      (s) => s.source_kind !== "listing_open"
    );
    const pdfLine = db
      .prepare(`SELECT id FROM cc_statement_lines WHERE statement_id = ? LIMIT 1`)
      .get(pdfStmt!.id) as { id: number };
    expect(() => deleteCcWebPasteStatementLine(master.id, pdfLine.id)).toThrow(/web-paste/);
  });
});
