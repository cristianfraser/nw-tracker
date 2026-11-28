import { BROKER_SETTLEMENT_WINDOW_DAYS } from "./brokerAdapter.js";
import { bankPostedOn, recordBankPosting } from "./movementBankPostings.js";
import { db } from "./db.js";
import { promoteSingleLegToTransfer } from "./movementWrites.js";
import { chileCalendarAddDays } from "./chileDate.js";
import { normalizeAccountNumber } from "nw-tracker-contracts";

/**
 * Pair a Fintual «Pagamos tu retiro» e-mail with the bank credit it produced, in the account the
 * mail names (the corriente or the cuenta vista).
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

/**
 * How far AFTER the e-mail's payment date the bank credit may post. The window is one-sided:
 * «Pagamos tu retiro» is dated the day the money left the fund, and a wire can post that day
 * or later (14:00 cutoff → next workday), never earlier. A symmetric window let the 2026-09-01
 * $5x.xxx retiro hijack an unrelated $5x.xxx credit dated 2026-08-28 — the real Fintual leg
 * was not imported yet, so the earlier row was the only candidate and got rewritten in place.
 */
export const WITHDRAWAL_PAIR_WINDOW_DAYS = BROKER_SETTLEMENT_WINDOW_DAYS;

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

export type RetiroDestination = { account_id: number } | { requires_manual: string };

/**
 * The account a retiro's pesos landed in: the one account number its mail prints
 * (`bank_account_numbers`, pesos, compared without punctuation or leading zeros). A mail that
 * prints none, or a number no account declares, is for a person — never guessed to be the corriente.
 */
export function retiroDestinationAccount(destinationAccount: string | null | undefined): RetiroDestination {
  if (!destinationAccount) {
    return { requires_manual: "the e-mail names no destination account — link it in /panel/mirror-pairs" };
  }
  const wanted = normalizeAccountNumber(destinationAccount);
  const rows = db
    .prepare(`SELECT account_id, number FROM bank_account_numbers WHERE currency = 'clp'`)
    .all() as { account_id: number; number: string }[];
  const hits = [...new Set(rows.filter((r) => normalizeAccountNumber(r.number) === wanted).map((r) => r.account_id))];
  if (hits.length === 0) {
    return { requires_manual: `destination account ${destinationAccount} is not in bank_account_numbers — declare it or link the retiro by hand` };
  }
  if (hits.length > 1) {
    return { requires_manual: `destination account ${destinationAccount} is declared for ${hits.length} accounts` };
  }
  return { account_id: hits[0]! };
}

/**
 * An unpaired credit on `accountId` for this amount dated on or after the payment date, within
 * {@link WITHDRAWAL_PAIR_WINDOW_DAYS}.
 *
 * Restricted to single-leg rows (`from_account_id`/`to_account_id` null): a row that is already a
 * transfer has been attributed, and re-promoting it would rewrite a real relationship. Ambiguity is
 * refused rather than guessed — two candidate credits of the same amount in the window means the
 * e-mail cannot say which one it paid. Credits dated BEFORE the payment day are never
 * candidates: they cannot be this retiro's money.
 */
export function findUnpairedBankCredit(
  accountId: number,
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
      accountId,
      amountClp,
      paidOn,
      chileCalendarAddDays(paidOn, windowDays)
    ) as CheckingCreditMatch[];
  if (rows.length === 0) return null;
  if (rows.length > 1) return "ambiguous";
  return rows[0]!;
}

/**
 * Turn the bank credit on `toAccountId` into a Fintual → that account transfer, in place.
 *
 * `occurredOn` lets the caller re-date the row to the e-mail's payment date — the day the money
 * really moved — when the credit carries the bank's next-workday posting date (post-14:00 wires).
 * The planner only picks that date when the cartola/xlsx re-import dedupe window still reaches it
 * and no month boundary is crossed; pass null to keep the credit's own date.
 */
export function promoteBankCreditToTransfer(
  movementId: number,
  fromAccountId: number,
  toAccountId: number,
  note: string,
  unitsDelta: string | null = null,
  occurredOn: string | null = null
): void {
  const before = db.prepare(`SELECT occurred_on FROM movements WHERE id = ?`).get(movementId) as
    | { occurred_on: string }
    | undefined;
  // The bank's day for the credit: its posting row when the daily import already stored it on
  // an earlier day (a post-cutoff row), else its date.
  const bankDay = before ? bankPostedOn(movementId, toAccountId) : null;
  const promoted = promoteSingleLegToTransfer(movementId, {
    fromAccountId,
    toAccountId,
    note,
    unitsDelta,
    occurredOn,
  });
  if (!promoted) {
    throw new Error(`Movement ${movementId} was not an unpaired single-leg row — not promoted`);
  }
  // The credit was the bank's listing: when the mail moves it to the payment day, its bank date
  // stays as the transfer's posting day on that account (the cartola files it there).
  recordBankPosting(movementId, toAccountId, bankDay!);
}
