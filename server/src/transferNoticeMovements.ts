/**
 * Movements written from a transfer mail, and their confirmation by a bank feed.
 *
 * A transfer is mailed the moment it is made — Banco de Chile mails the recipient of its clients'
 * transfers, Santander mails some incoming ones and a receipt for every payment the user makes to a
 * third party — while the checking account's own feed only arrives with the 22:00 bank session. So
 * `applyBankTransferNotices` writes the movement from the mail (a credit in, a debit out), dated
 * the day the mail was sent, and records it here with its pesos signed for the account. When the
 * bank lists the same money, the checking importers keep the mail's row and skip the bank's
 * (`findTransferNoticeMovementForBankRow`, same shape as the transfer-leg skip), stamping the
 * bank's day as the movement's posting day and the bank's description for provenance. A movement
 * no feed lists within the grace is reported overdue: the money never moved as the mail said, and
 * without the alarm it would be absorbed into the next checking-anchor re-derivation.
 *
 * Deliberately a leaf module (db + calendar helpers only), so the checking importers can depend on
 * it without a cycle — same rule as fintualSyntheticRetiros.ts.
 */
import type { Database } from "better-sqlite3";
import { db } from "./db.js";
import { nextChileBusinessDayYmd, priorChileBusinessDayYmd } from "./marketHolidays.js";
import { recordBankPosting } from "./movementBankPostings.js";

export type TransferNoticeMovementConfirmSource = "ultimos_xlsx" | "cartola";

/** Business days after the mail's day by which a bank feed must have listed the movement. */
export const TRANSFER_NOTICE_MOVEMENT_GRACE_BUSINESS_DAYS = 2;

/**
 * The mail-written movement a bank row of `accountId` dated `bankDateYmd` lists, if any: the same
 * signed pesos, either already confirmed on that exact bank day (the daily feed re-lists a row every night
 * until it ages out, and the cartola lists it again) or unconfirmed and mailed from the business
 * day before the bank day through the bank day itself (a transfer after the 14:00 cutoff, or on a
 * weekend, posts on the next business day; a bank never posts before the transfer was made).
 * Exact-day confirmations first, then the oldest mail. `consumed` keeps one import run from
 * giving one movement to two bank rows.
 */
export function findTransferNoticeMovementForBankRow(
  accountId: number,
  bankDateYmd: string,
  amountClpSigned: number,
  consumed: ReadonlySet<number>,
  dbHandle: Database = db
): number | null {
  if (!Number.isFinite(amountClpSigned) || amountClpSigned === 0) return null;
  const windowStart = priorChileBusinessDayYmd(bankDateYmd) ?? bankDateYmd;
  const rows = dbHandle
    .prepare(
      `SELECT c.movement_id
       FROM transfer_notice_movements c JOIN movements m ON m.id = c.movement_id
       WHERE c.account_id = ? AND c.amount = ?
         AND (c.confirmed_on = ? OR (c.confirmed_on IS NULL AND m.occurred_on BETWEEN ? AND ?))
       ORDER BY (c.confirmed_on IS NULL), m.occurred_on, m.id`
    )
    .all(accountId, Math.round(amountClpSigned), bankDateYmd, windowStart, bankDateYmd) as { movement_id: number }[];
  return rows.find((r) => !consumed.has(r.movement_id))?.movement_id ?? null;
}

/**
 * The bank listed a mail-written movement: its day becomes the movement's posting day on the
 * account, and the first confirmation's day, source and description are kept.
 */
export function confirmTransferNoticeMovement(
  movementId: number,
  accountId: number,
  bankDateYmd: string,
  source: TransferNoticeMovementConfirmSource,
  bankDescription: string,
  dbHandle: Database = db
): void {
  recordBankPosting(movementId, accountId, bankDateYmd, dbHandle);
  dbHandle
    .prepare(
      `UPDATE transfer_notice_movements
       SET confirmed_on = ?, confirmed_source = ?, bank_description = ?
       WHERE movement_id = ? AND confirmed_on IS NULL`
    )
    .run(bankDateYmd, source, bankDescription, movementId);
}

/** Last day a bank listing is still on time: the mail's day + the grace business days. */
export function transferNoticeMovementDeadlineYmd(noticeDateYmd: string): string | null {
  let cur: string | null = noticeDateYmd;
  for (let i = 0; i < TRANSFER_NOTICE_MOVEMENT_GRACE_BUSINESS_DAYS; i++) {
    cur = nextChileBusinessDayYmd(cur);
    if (cur == null) return null;
  }
  return cur;
}

export type OverdueTransferNoticeMovement = {
  message_id: string;
  movement_id: number;
  date: string;
  amount: number;
  /** Null only if the deadline walk failed — treated as overdue rather than hidden. */
  deadline: string | null;
};

export function listOverdueTransferNoticeMovements(todayYmd: string, dbHandle: Database = db): OverdueTransferNoticeMovement[] {
  const rows = dbHandle
    .prepare(
      `SELECT message_id, movement_id, notice_date AS date, amount FROM transfer_notice_movements
       WHERE confirmed_on IS NULL AND movement_id IS NOT NULL
       ORDER BY notice_date, movement_id`
    )
    .all() as Omit<OverdueTransferNoticeMovement, "deadline">[];
  return rows
    .map((r) => ({ ...r, deadline: transferNoticeMovementDeadlineYmd(r.date) }))
    .filter((r) => r.deadline == null || todayYmd > r.deadline);
}
