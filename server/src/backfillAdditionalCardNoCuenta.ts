import type { Database } from "better-sqlite3";
import { applyAdditionalCardNoCuentaForLine } from "./ccAdditionalCardExpenseMatch.js";
import { db } from "./db.js";

type AdditionalCardLineRow = {
  id: number;
  account_id: number;
  origin_card_last4: string;
  primary_card_last4: string;
};

export function backfillAdditionalCardNoCuenta(dbHandle: Database = db): {
  scanned: number;
  updated: number;
  notes_updated: number;
  skipped_cleared: number;
} {
  const rows = dbHandle
    .prepare(
      `SELECT l.id, s.account_id, l.origin_card_last4, s.card_last4 AS primary_card_last4
       FROM cc_statement_lines l
       JOIN cc_statements s ON s.id = l.statement_id
       WHERE l.origin_card_last4 IS NOT NULL
         AND s.card_last4 IS NOT NULL
         AND l.origin_card_last4 != s.card_last4`
    )
    .all() as AdditionalCardLineRow[];

  let updated = 0;
  let notesUpdated = 0;
  let skippedCleared = 0;

  const tx = dbHandle.transaction(() => {
    for (const row of rows) {
      const result = applyAdditionalCardNoCuentaForLine({
        accountId: row.account_id,
        statementLineId: row.id,
        originCardLast4: row.origin_card_last4,
        primaryCardLast4: row.primary_card_last4,
        dbHandle,
      });
      if (result.skippedUserCleared) {
        skippedCleared += 1;
        continue;
      }
      if (result.applied) {
        updated += 1;
        if (result.notesUpdated) notesUpdated += 1;
      }
    }
  });
  tx();

  return {
    scanned: rows.length,
    updated,
    notes_updated: notesUpdated,
    skipped_cleared: skippedCleared,
  };
}
