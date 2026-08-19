/**
 * Synthetic Fintual retiro transfers — structured provenance + bank-confirmation state.
 *
 * A «Pagamos tu retiro» e-mail carries exact amount, payment date, goal AND cuota count, so
 * `fintualEmailImport` writes the goal → checking transfer from the mail alone when the bank
 * credit has not been imported yet (the daily «últimos movimientos» xlsx only arrives with the
 * nightly 22:00 bank session). Each synthesis is recorded here; when the bank's own listing of
 * the credit shows up, the checking importers skip it as `superseded_by_transfer`
 * (`findMatchingInternalTransferLegId`) and stamp the confirmation — the skip inserts nothing,
 * so the stamp is the only trace that the bank really paid. A row still unconfirmed after the
 * posting window means the promised wire never appeared in any bank feed: without an alert the
 * phantom credit would be silently absorbed into the next checking-anchor re-derivation
 * instead of failing loudly.
 *
 * Deliberately a leaf module (db + calendar helpers only) so the checking importers can depend
 * on it without a cycle — same rule as ccStatementFingerprint.ts.
 */
import type { Database } from "better-sqlite3";
import { db } from "./db.js";
import { nextChileBusinessDayYmd } from "./marketHolidays.js";

export type SyntheticRetiroConfirmSource = "ultimos_xlsx" | "cartola";

/**
 * Business days the bank listing may lag the mail's payment date before it counts as missing:
 * the wire posts same-day or next business day (14:00 cutoff) and the nightly xlsx import
 * lands it that same evening — the extra day absorbs a slept-through nightly run.
 */
export const SYNTHETIC_RETIRO_CONFIRM_GRACE_BUSINESS_DAYS = 2;

export function recordSyntheticRetiroTransfer(
  movementId: number,
  messageId: string,
  amountClp: number,
  paidOnYmd: string,
  dbHandle: Database = db
): void {
  dbHandle
    .prepare(
      `INSERT INTO fintual_synthetic_retiro_transfers (movement_id, message_id, amount_clp, paid_on)
       VALUES (?, ?, ?, ?)`
    )
    .run(movementId, messageId, amountClp, paidOnYmd);
}

/**
 * Stamp a synthesized retiro as confirmed by a bank feed. Called by the checking importers on
 * every `superseded_by_transfer` skip — a no-op for ordinary manual transfer legs (the usual
 * case for that skip), and an already-confirmed row keeps its first stamp.
 */
export function confirmSyntheticRetiroForTransferLeg(
  transferLegId: number,
  bankDateYmd: string,
  source: SyntheticRetiroConfirmSource,
  dbHandle: Database = db
): void {
  dbHandle
    .prepare(
      `UPDATE fintual_synthetic_retiro_transfers
       SET confirmed_on = ?, confirmed_source = ?
       WHERE movement_id = ? AND confirmed_on IS NULL`
    )
    .run(bankDateYmd, source, transferLegId);
}

/** Last day a bank listing is still on time: `paid_on` + the grace business days. */
export function syntheticRetiroConfirmationDeadlineYmd(paidOnYmd: string): string | null {
  let cur: string | null = paidOnYmd;
  for (let i = 0; i < SYNTHETIC_RETIRO_CONFIRM_GRACE_BUSINESS_DAYS; i++) {
    cur = nextChileBusinessDayYmd(cur);
    if (cur == null) return null;
  }
  return cur;
}

export type OverdueSyntheticRetiro = {
  movement_id: number;
  message_id: string;
  amount_clp: number;
  paid_on: string;
  /** Null only if the deadline walk failed — treated as overdue rather than hidden. */
  deadline: string | null;
};

export function listOverdueUnconfirmedSyntheticRetiros(
  todayYmd: string,
  dbHandle: Database = db
): OverdueSyntheticRetiro[] {
  const rows = dbHandle
    .prepare(
      `SELECT movement_id, message_id, amount_clp, paid_on
       FROM fintual_synthetic_retiro_transfers
       WHERE confirmed_on IS NULL
       ORDER BY paid_on, movement_id`
    )
    .all() as Omit<OverdueSyntheticRetiro, "deadline">[];
  return rows
    .map((r) => ({ ...r, deadline: syntheticRetiroConfirmationDeadlineYmd(r.paid_on) }))
    .filter((r) => r.deadline == null || todayYmd > r.deadline);
}
