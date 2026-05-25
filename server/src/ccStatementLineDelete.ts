import { recomputeCcBillingMonthBalances } from "./ccBillingBalances.js";
import { deleteStatementLinesByIds } from "./ccCrossImportDedupe.js";
import { db } from "./db.js";

function isWebPasteStatementSource(sourcePdf: string): boolean {
  return String(sourcePdf ?? "").trim().startsWith("import:web-paste");
}

/** Delete one line from an open web-paste facturación bucket; recompute billing balances. */
export function deleteCcWebPasteStatementLine(
  accountId: number,
  statementLineId: number
): { removed_count: number } {
  const row = db
    .prepare(
      `SELECT l.id, s.account_id, s.source_pdf
       FROM cc_statement_lines l
       JOIN cc_statements s ON s.id = l.statement_id
       WHERE l.id = ?`
    )
    .get(statementLineId) as
    | { id: number; account_id: number; source_pdf: string }
    | undefined;

  if (!row) throw new Error("statement line not found");
  if (row.account_id !== accountId) throw new Error("statement line not on this account");
  if (!isWebPasteStatementSource(row.source_pdf)) {
    throw new Error("only web-paste statement lines can be deleted");
  }

  const removed_count = deleteStatementLinesByIds([statementLineId]);
  if (removed_count > 0) {
    recomputeCcBillingMonthBalances(accountId);
  }
  return { removed_count };
}
