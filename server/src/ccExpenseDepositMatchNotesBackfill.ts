import { db } from "./db.js";
import { mergeAutoDepositMatchNote } from "./ccExpenseDepositMatchNotes.js";
import {
  getCcExpensePurchaseNote,
  setCcExpensePurchaseNote,
} from "./ccExpensePurchaseNotes.js";
import { resolvePurchaseKeyForGastosLine } from "./ccExpensePurchaseKey.js";
import { buildCheckingGastosLines } from "./flowsCheckingGastos.js";

export function backfillDepositMatchNotes(): { upserted: number; unchanged: number } {
  const drafts = buildCheckingGastosLines();
  let upserted = 0;
  let unchanged = 0;

  for (const ln of drafts) {
    if (!ln.auto_deposit_match_note) continue;
    const purchaseKey = resolvePurchaseKeyForGastosLine(ln);
    const existing = getCcExpensePurchaseNote(ln.account_id, purchaseKey);
    const merged = mergeAutoDepositMatchNote(existing, ln.auto_deposit_match_note);
    if (merged === existing.trim()) {
      unchanged += 1;
      continue;
    }
    setCcExpensePurchaseNote({
      accountId: ln.account_id,
      purchaseKey,
      notes: merged,
    });
    upserted += 1;
  }

  return { upserted, unchanged };
}

/** @internal test hook */
export function countPersistedDepositMatchNotes(): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM cc_expense_purchase_notes WHERE notes LIKE 'auto:deposit-match%'`
      )
      .get() as { c: number }
  ).c;
}
