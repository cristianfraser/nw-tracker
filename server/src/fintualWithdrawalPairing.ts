import { db } from "./db.js";
import { checkingAccountId } from "./checkingCartolaImport.js";
import { chileCalendarAddDays } from "./chileDate.js";

/**
 * Pair a Fintual «Pagamos tu retiro» e-mail with the checking credit it produced.
 *
 * The e-mail confirms one side of a wire and the checking importer brings the other; exactly ONE
 * ledger row must ever exist for the event. The e-mail carries an exact amount, an exact date and
 * the goal it came from — stronger evidence than the generic mirror-pair matcher usually has — so
 * both arrival orders resolve unattended (fintualEmailImport):
 *
 *   - Credit first (mail fetched after the nightly import): the credit is PROMOTED IN PLACE into
 *     the transfer — `account_id` cleared, `from`/`to` set — keeping the movement id and making a
 *     second row structurally impossible.
 *   - Mail first (retiro paid in the morning; the daily xlsx only arrives at 22:00): the transfer
 *     is SYNTHESIZED from the mail, and the checking importers skip the bank's later listing of
 *     the credit as `superseded_by_transfer` (`findMatchingInternalTransferLegId`), stamping the
 *     confirmation in `fintual_synthetic_retiro_transfers` (see fintualSyntheticRetiros.ts).
 */

/** How far the bank credit may sit from the e-mail's payment date. */
export const WITHDRAWAL_PAIR_WINDOW_DAYS = 5;

/** `Pagamos tu retiro de 🏦 Reserva` → `Reserva`. */
export function fintualGoalFromWithdrawalSubject(subject: string): string | null {
  const m = /pagamos tu retiro de\s+(.+)$/i.exec(String(subject ?? "").trim());
  if (!m) return null;
  // Strip emoji/pictographs and collapse whitespace; the goal name itself is plain text.
  const name = m[1]!
    .replace(/[\p{Extended_Pictographic}\p{Emoji_Presentation}️]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return name || null;
}

/** Fintual goal account by its display name (the goals are the `import:fintual|cert|` accounts). */
export function fintualGoalAccountId(goalName: string): number | null {
  const row = db
    .prepare(
      `SELECT id FROM accounts
       WHERE import_key LIKE 'import:fintual|cert|%'
         AND lower(trim(name)) = lower(trim(?))
       LIMIT 1`
    )
    .get(goalName) as { id: number } | undefined;
  return row?.id ?? null;
}

export type CheckingCreditMatch = { id: number; occurred_on: string };

/**
 * An unpaired checking credit for this amount near this date.
 *
 * Restricted to single-leg rows (`from_account_id`/`to_account_id` null): a row that is already a
 * transfer has been attributed, and re-promoting it would rewrite a real relationship. Ambiguity is
 * refused rather than guessed — two candidate credits of the same amount in the window means the
 * e-mail cannot say which one it paid.
 */
export function findUnpairedCheckingCredit(
  amountClp: number,
  paidOn: string,
  windowDays = WITHDRAWAL_PAIR_WINDOW_DAYS
): CheckingCreditMatch | "ambiguous" | null {
  const rows = db
    .prepare(
      `SELECT id, occurred_on FROM movements
       WHERE account_id = ?
         AND from_account_id IS NULL AND to_account_id IS NULL
         AND currency = 'clp'
         AND ROUND(amount) = ROUND(?)
         AND occurred_on BETWEEN ? AND ?
       ORDER BY occurred_on`
    )
    .all(
      checkingAccountId(),
      amountClp,
      chileCalendarAddDays(paidOn, -windowDays),
      chileCalendarAddDays(paidOn, windowDays)
    ) as CheckingCreditMatch[];
  if (rows.length === 0) return null;
  if (rows.length > 1) return "ambiguous";
  return rows[0]!;
}

/**
 * Turn the checking credit into a Fintual → checking transfer, in place.
 *
 * `occurredOn` lets the caller re-date the row to the e-mail's payment date — the day the money
 * really moved — when the credit carries the bank's next-workday posting date (post-14:00 wires).
 * The planner only picks that date when the cartola/xlsx re-import dedupe window still reaches it
 * and no month boundary is crossed; pass null to keep the credit's own date.
 */
export function promoteCheckingCreditToTransfer(
  movementId: number,
  fromAccountId: number,
  note: string,
  unitsDelta: string | null = null,
  occurredOn: string | null = null
): void {
  const changed = db
    .prepare(
      `UPDATE movements
       SET account_id = NULL, from_account_id = ?, to_account_id = ?, note = ?, units_delta = ?,
           occurred_on = COALESCE(?, occurred_on)
       WHERE id = ? AND from_account_id IS NULL AND to_account_id IS NULL`
    )
    .run(fromAccountId, checkingAccountId(), note, unitsDelta, occurredOn, movementId).changes;
  if (changed !== 1) {
    throw new Error(`Movement ${movementId} was not an unpaired single-leg row — not promoted`);
  }
}
