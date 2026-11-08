import { describe, expect, it } from "vitest";
import { db } from "./db.js";
import {
  ccStatementSourceKindOf,
  isCorpusPdfSourceKind,
  isJsonStatementSourceKind,
  isListingSourceKind,
  isStatementSourceKind,
  type CcStatementSourceKind,
} from "./ccStatementSourceKind.js";

const CASES: [string, CcStatementSourceKind][] = [
  ["2026-07-23 estado de cuenta tarjeta 0001.pdf", "statement_pdf"],
  ["import:santander-json|clp|23/07/2026", "statement_json"],
  ["import:santander-mail|2019-08|0001", "statement_other"],
  ["import:cmr|2020-01", "statement_other"],
  ["import:estimate|usd|2017-07", "statement_other"],
  ["", "statement_other"],
  ["import:web-paste|open|2026-09", "listing_open"],
  ["import:web-paste|vitest-other", "listing_other"],
];

describe("cc statement source kind", () => {
  it.each(CASES)("classifies %s as %s, the same as the stored column", (sourcePdf, kind) => {
    expect(ccStatementSourceKindOf(sourcePdf)).toBe(kind);
    const stored = db.transaction(() => {
      const accountId = (db.prepare(`SELECT id FROM accounts ORDER BY id LIMIT 1`).get() as { id: number }).id;
      const id = db
        .prepare(
          `INSERT INTO cc_statements (account_id, card_group, source_pdf, statement_date, currency)
           VALUES (?, 'vitest-kind', ?, '01/01/2099', 'clp')`
        )
        .run(accountId, sourcePdf).lastInsertRowid;
      const row = db.prepare(`SELECT source_kind FROM cc_statements WHERE id = ?`).get(id) as { source_kind: string };
      db.prepare(`DELETE FROM cc_statements WHERE id = ?`).run(id);
      return row.source_kind;
    })();
    expect(stored).toBe(kind);
  });

  it("answers the questions the readers ask", () => {
    expect(isListingSourceKind("listing_open")).toBe(true);
    expect(isListingSourceKind("listing_other")).toBe(true);
    expect(isStatementSourceKind("statement_other")).toBe(true);
    expect(isCorpusPdfSourceKind("statement_pdf")).toBe(true);
    expect(isCorpusPdfSourceKind("statement_json")).toBe(false);
    expect(isJsonStatementSourceKind("statement_json")).toBe(true);
    expect(() => isListingSourceKind(undefined)).toThrow(/select the column/);
  });
});
