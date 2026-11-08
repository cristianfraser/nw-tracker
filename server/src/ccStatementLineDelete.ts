import { InputError } from "./inputError.js";
import { isListingSourceKind } from "./ccStatementSourceKind.js";
import { deleteLines } from "./cards/lineWrites.js";
import { db } from "./db.js";

/**
 * Delete one line from an open web-paste facturación bucket, through the card-line funnel: its
 * evidence date read first, the payment-evidence guard (a pasted PAGO / ABONO DE DIVISAS line can
 * be the only evidence of a converted card payment — deleting it throws), then the balances
 * recomputed and the valuations re-synced from the line's date (the stamps it contradicts go).
 */
export function deleteCcWebPasteStatementLine(
  accountId: number,
  statementLineId: number
): { removed_count: number } {
  const row = db
    .prepare(
      `SELECT l.id, s.account_id, s.source_kind
       FROM cc_statement_lines l
       JOIN cc_statements s ON s.id = l.statement_id
       WHERE l.id = ?`
    )
    .get(statementLineId) as
    | { id: number; account_id: number; source_kind: string }
    | undefined;

  if (!row) throw new InputError("statement line not found");
  if (row.account_id !== accountId) throw new InputError("statement line not on this account");
  if (!isListingSourceKind(row.source_kind)) {
    throw new InputError("only web-paste statement lines can be deleted");
  }
  return {
    removed_count: deleteLines(accountId, [statementLineId], { what: `deleting statement line ${statementLineId}` }),
  };
}
