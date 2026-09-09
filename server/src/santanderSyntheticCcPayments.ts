/**
 * Synthetic Santander card-payment transfers — structured provenance + bank-confirmation state.
 *
 * A payment receipt mail («Pago Deuda Nacional TCR», «Comprobante Pago (abono) de la deuda
 * facturada en dolares») carries the exact pesos that left checking, the payment date, the card
 * and — for the dollar abono — the USD amount, so `santanderCcPaymentReceipts` writes the
 * checking → card `pago_tarjeta` transfer from the mail alone when the bank feed has not
 * delivered the checking debit yet (the daily «últimos movimientos» xlsx only arrives with the
 * nightly bank session). Each synthesis is recorded here; when the bank's own listing of the
 * debit shows up, the checking importers skip it as `superseded_by_transfer`
 * (`findMatchingInternalTransferLegId`) and stamp the confirmation — the skip inserts nothing,
 * so the stamp is the only trace that the bank really moved the money. A row still unconfirmed
 * after the posting window means the receipt's debit never appeared in any bank feed.
 *
 * Twin of `fintualSyntheticRetiros.ts`, and a leaf module for the same reason: the checking
 * importers depend on it without a cycle.
 */
import type { Database } from "better-sqlite3";
import { db } from "./db.js";
import {
  syntheticRetiroConfirmationDeadlineYmd,
  type SyntheticRetiroConfirmSource,
} from "./fintualSyntheticRetiros.js";

export type SyntheticCcPaymentConfirmSource = SyntheticRetiroConfirmSource;

export function recordSyntheticCcPaymentTransfer(
  movementId: number,
  messageId: string,
  amountClp: number,
  paidOnYmd: string,
  dbHandle: Database = db
): void {
  dbHandle
    .prepare(
      `INSERT INTO santander_synthetic_cc_payment_transfers (movement_id, message_id, amount_clp, paid_on)
       VALUES (?, ?, ?, ?)`
    )
    .run(movementId, messageId, amountClp, paidOnYmd);
}

/** The transfer an earlier run synthesized from this exact receipt, if any. */
export function syntheticCcPaymentMovementIdForMessageId(
  messageId: string,
  dbHandle: Database = db
): number | null {
  const row = dbHandle
    .prepare(`SELECT movement_id FROM santander_synthetic_cc_payment_transfers WHERE message_id = ?`)
    .get(messageId) as { movement_id: number } | undefined;
  return row?.movement_id ?? null;
}

/**
 * Stamp a synthesized card payment as confirmed by a bank feed. Called by the checking importers
 * on every `superseded_by_transfer` skip — a no-op for every other transfer leg, and an
 * already-confirmed row keeps its first stamp.
 */
export function confirmSyntheticCcPaymentForTransferLeg(
  transferLegId: number,
  bankDateYmd: string,
  source: SyntheticCcPaymentConfirmSource,
  dbHandle: Database = db
): void {
  dbHandle
    .prepare(
      `UPDATE santander_synthetic_cc_payment_transfers
       SET confirmed_on = ?, confirmed_source = ?
       WHERE movement_id = ? AND confirmed_on IS NULL`
    )
    .run(bankDateYmd, source, transferLegId);
}

export type OverdueSyntheticCcPayment = {
  movement_id: number;
  message_id: string;
  amount_clp: number;
  paid_on: string;
  /** Null only if the deadline walk failed — treated as overdue rather than hidden. */
  deadline: string | null;
};

/** Synthesized payments whose checking debit no bank feed has listed by the posting deadline. */
export function listOverdueUnconfirmedSyntheticCcPayments(
  todayYmd: string,
  dbHandle: Database = db
): OverdueSyntheticCcPayment[] {
  const rows = dbHandle
    .prepare(
      `SELECT movement_id, message_id, amount_clp, paid_on
       FROM santander_synthetic_cc_payment_transfers
       WHERE confirmed_on IS NULL
       ORDER BY paid_on, movement_id`
    )
    .all() as Omit<OverdueSyntheticCcPayment, "deadline">[];
  return rows
    .map((r) => ({ ...r, deadline: syntheticRetiroConfirmationDeadlineYmd(r.paid_on) }))
    .filter((r) => r.deadline == null || todayYmd > r.deadline);
}
