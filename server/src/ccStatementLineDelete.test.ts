import { describe, expect, it } from "vitest";
import { db } from "./db.js";
import { deleteCcWebPasteStatementLine } from "./ccStatementLineDelete.js";
import { listCcStatementsForAccount } from "./ccStatementsDb.js";

describe("deleteCcWebPasteStatementLine", () => {
  it("deletes a web-paste line and rejects PDF lines", () => {
    const master = db
      .prepare(`SELECT id FROM accounts WHERE notes = 'credit_card_master|santander|4242'`)
      .get() as { id: number } | undefined;
    if (!master) return;

    const webPasteStmt = listCcStatementsForAccount(master.id).find((s) =>
      String(s.source_pdf).startsWith("import:web-paste")
    );
    if (!webPasteStmt) return;

    const line = db
      .prepare(`SELECT id FROM cc_statement_lines WHERE statement_id = ? LIMIT 1`)
      .get(webPasteStmt.id) as { id: number } | undefined;
    if (!line) return;

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
      (s) => !String(s.source_pdf).startsWith("import:web-paste")
    );
    if (pdfStmt) {
      const pdfLine = db
        .prepare(`SELECT id FROM cc_statement_lines WHERE statement_id = ? LIMIT 1`)
        .get(pdfStmt.id) as { id: number } | undefined;
      if (pdfLine) {
        expect(() => deleteCcWebPasteStatementLine(master.id, pdfLine.id)).toThrow(
          /web-paste/
        );
      }
    }
  });
});
