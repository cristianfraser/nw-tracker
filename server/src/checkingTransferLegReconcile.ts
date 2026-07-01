/**
 * Cross-path dedup: a checking movement being imported (web-paste "últimos movimientos" or cartola
 * PDF) may already be represented by a **manual internal transfer leg** (`account_id IS NULL`,
 * `from`/`to` both set) touching the checking account — e.g. a brokerage_CLP ↔ cuenta corriente
 * transit recorded by hand before the bank statement was imported. Re-inserting the bank row would
 * double-count the account, so the importer skips it and lets the single transfer row stand.
 *
 * Matching is by (account, signed CLP amount, date window): the transfer's signed impact on the
 * checking account equals the bank movement's `amount_clp` (abono +, cargo −). The date is a window,
 * not an exact match: Chilean bank cutoff is ~14:00, so a transfer made after cutoff — or on a
 * weekend/holiday — posts on the **next business day**. So a bank row dated `D` can match a transfer
 * logged anywhere in `[priorChileBusinessDay(D), D]` (the prior business day, any weekend/holiday
 * days between, and `D` itself). A `consumed` set enforces one-to-one matching, and candidates
 * closest to the bank date win first.
 */
import type { Database } from "better-sqlite3";
import { db } from "./db.js";
import { priorChileBusinessDayYmd } from "./marketHolidays.js";
import { bucketSlugForAccountId } from "./accountBucket.js";
import { isMovementBalanceCashCategory } from "./movementBalanceCashAccounts.js";
import { clearCheckingBalanceCache } from "./checkingCartolaBalances.js";
import { invalidateAggregationForAccountDate } from "./aggregationCache.js";

type TransferLegRow = {
  id: number;
  from_account_id: number | null;
  to_account_id: number | null;
  amount_clp: number;
};

/** Signed CLP impact of an internal transfer leg on `accountId` (to = +, from = −). */
function signedTransferLegDelta(row: TransferLegRow, accountId: number): number {
  const mag = Math.abs(row.amount_clp);
  if (row.to_account_id === accountId) return mag;
  if (row.from_account_id === accountId) return -mag;
  return 0;
}

/**
 * Id of an existing internal transfer leg touching `accountId` whose signed CLP delta equals
 * `amountClpSigned`, logged within the business-day window ending at the bank posting date
 * `bankDateYmd` (`[priorChileBusinessDay(bankDate), bankDate]`), and not yet claimed — else null.
 * Candidates closest to the bank date are preferred (same-day before an earlier day).
 */
export function findMatchingInternalTransferLegId(
  accountId: number,
  bankDateYmd: string,
  amountClpSigned: number,
  consumed: Set<number>,
  dbHandle: Database = db
): number | null {
  if (!Number.isFinite(amountClpSigned) || amountClpSigned === 0) return null;
  const target = Math.round(amountClpSigned);
  const windowStart = priorChileBusinessDayYmd(bankDateYmd) ?? bankDateYmd;
  const rows = dbHandle
    .prepare(
      `SELECT id, from_account_id, to_account_id, amount_clp
       FROM movements
       WHERE account_id IS NULL
         AND (from_account_id = ? OR to_account_id = ?)
         AND occurred_on >= ? AND occurred_on <= ?
       ORDER BY occurred_on DESC, id DESC`
    )
    .all(accountId, accountId, windowStart, bankDateYmd) as TransferLegRow[];
  for (const r of rows) {
    if (consumed.has(r.id)) continue;
    if (Math.round(signedTransferLegDelta(r, accountId)) === target) return r.id;
  }
  return null;
}

type ImportedCheckingRow = { id: number; occurred_on: string };

/** True when a bank movement dated `bankDate` could be a transfer effective on `transferDate`
 * (`priorChileBusinessDay(bankDate) <= transferDate <= bankDate`). */
function bankDateMatchesTransferDate(bankDate: string, transferDate: string): boolean {
  if (bankDate < transferDate) return false;
  if (bankDate === transferDate) return true;
  const prior = priorChileBusinessDayYmd(bankDate);
  return prior != null && prior <= transferDate;
}

/**
 * Reverse direction: a checking bank row (web-paste / cartola) was imported *before* the matching
 * internal transfer was recorded by hand. Inserting the transfer would double-count the checking
 * account, so when a transfer touching a cartola checking account is created we remove the already
 * imported bank row it supersedes — leaving the single transfer as the one representation (symmetric
 * with the import-time skip). Matching is signed amount + the same business-day window, one-to-one.
 */
export function supersedeImportedCheckingRowsForTransfer(
  fromAccountId: number,
  toAccountId: number,
  amountClp: number,
  occurredOn: string,
  dbHandle: Database = db
): { removed_ids: number[] } {
  const mag = Math.abs(amountClp);
  const removed_ids: number[] = [];
  if (!Number.isFinite(mag) || mag === 0) return { removed_ids };
  const del = dbHandle.prepare(`DELETE FROM movements WHERE id = ?`);
  // to-endpoint sees +abono, from-endpoint sees −cargo.
  for (const [endpoint, signed] of [
    [toAccountId, mag] as const,
    [fromAccountId, -mag] as const,
  ]) {
    const slug = bucketSlugForAccountId(endpoint);
    if (!slug || !isMovementBalanceCashCategory(slug)) continue;
    const candidates = dbHandle
      .prepare(
        `SELECT id, occurred_on FROM movements
         WHERE account_id = ?
           AND ABS(amount_clp - ?) < 0.5
           AND occurred_on >= ?
           AND occurred_on <= date(?, '+10 days')
           AND (note LIKE 'import:cartola|%' OR note LIKE 'import:cartola-partial|%')
           AND note NOT LIKE 'import:cartola|anchor|%'
         ORDER BY occurred_on ASC, id ASC`
      )
      .all(endpoint, Math.round(signed), occurredOn, occurredOn) as ImportedCheckingRow[];
    const match = candidates.find((r) => bankDateMatchesTransferDate(r.occurred_on, occurredOn));
    if (!match) continue;
    del.run(match.id);
    removed_ids.push(match.id);
    clearCheckingBalanceCache(endpoint);
    invalidateAggregationForAccountDate(endpoint, match.occurred_on);
  }
  return { removed_ids };
}
