/**
 * The bank's posting day for a movement on one account, when it differs from the movement's
 * own date (migration 199, `movement_bank_postings`).
 *
 * `occurred_on` is the best evidence of when the money moved: a payment receipt, a broker
 * mail, the card's credit date. A bank document files the same money under its own posting
 * day — after Santander's 14:00 cutoff that is the next workday, sometimes next month. Every
 * display, chart and P/L reads `occurred_on`; reconciliation against a bank document (the
 * checking ledger anchor, the cartola month table, the xlsx/cartola import dedupe) reads the
 * posting day, so a movement dated 09-30 that the bank posted on 10-01 counts in the
 * September display and in the October cartola, and neither is wrong.
 *
 * The posting day is written by whatever learns it: a bank import that dedupes a row against an
 * existing transfer leg, a receipt that re-dates a bank row, a mirror conversion that absorbs a
 * bank row. The table stays sparse — posting on `occurred_on` stores nothing.
 */
import type { Database } from "better-sqlite3";
import { db } from "./db.js";

/**
 * JOIN fragment exposing `bp.posted_on` for movements aliased `m`; binds ONE parameter, the
 * account id. Read the bank date as {@link BANK_POSTED_ON_SQL}.
 */
export const BANK_POSTING_JOIN_SQL =
  "LEFT JOIN movement_bank_postings bp ON bp.movement_id = m.id AND bp.account_id = ?";

/** The bank's posting day of movement `m` on the joined account. */
export const BANK_POSTED_ON_SQL = "COALESCE(bp.posted_on, m.occurred_on)";

/**
 * Record that the bank posted `movementId` on `accountId` at `postedOn`. A posting on the
 * movement's own date removes any stored row (sparse). Throws when the movement does not touch
 * the account — a posting can only belong to one of the movement's own legs.
 */
export function recordBankPosting(
  movementId: number,
  accountId: number,
  postedOn: string,
  dbHandle: Database = db
): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(postedOn)) {
    throw new Error(`Bank posting date must be YYYY-MM-DD, got "${postedOn}" (movement ${movementId})`);
  }
  const mv = dbHandle
    .prepare(`SELECT occurred_on, account_id, from_account_id, to_account_id FROM movements WHERE id = ?`)
    .get(movementId) as
    | { occurred_on: string; account_id: number | null; from_account_id: number | null; to_account_id: number | null }
    | undefined;
  if (!mv) throw new Error(`Bank posting for missing movement ${movementId}`);
  if (mv.account_id !== accountId && mv.from_account_id !== accountId && mv.to_account_id !== accountId) {
    throw new Error(`Movement ${movementId} does not touch account ${accountId} — cannot record its bank posting`);
  }
  if (postedOn === mv.occurred_on) {
    dbHandle
      .prepare(`DELETE FROM movement_bank_postings WHERE movement_id = ? AND account_id = ?`)
      .run(movementId, accountId);
    return;
  }
  dbHandle
    .prepare(
      `INSERT INTO movement_bank_postings (movement_id, account_id, posted_on) VALUES (?, ?, ?)
       ON CONFLICT (movement_id, account_id) DO UPDATE SET posted_on = excluded.posted_on`
    )
    .run(movementId, accountId, postedOn);
}

/** The bank's posting day of a movement on an account (its own date when none is stored). */
export function bankPostedOn(movementId: number, accountId: number, dbHandle: Database = db): string {
  const row = dbHandle
    .prepare(
      `SELECT ${BANK_POSTED_ON_SQL} AS posted_on FROM movements m ${BANK_POSTING_JOIN_SQL} WHERE m.id = ?`
    )
    .get(accountId, movementId) as { posted_on: string } | undefined;
  if (!row) throw new Error(`Bank posting for missing movement ${movementId}`);
  return row.posted_on;
}
