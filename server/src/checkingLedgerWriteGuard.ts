/**
 * A hand-entered movement on a cash cartola account is judged by what IT does to the ledger, not
 * by the ledger's state: the anchor the cartolas on file derive (`getCartolaDerivedAnchor`) is read
 * before and after the write, in one transaction, and the write is refused only when it moves it —
 * the movement changes a balance a cartola on file states, and a cartola lists every movement of
 * its month, so a movement it does not list contradicts it. A movement dated after the newest
 * cartola's close never moves it; a transfer that supersedes the bank row it stands for
 * (`supersedeImportedCheckingRowsForTransfer`) nets to zero and is accepted. A ledger that already
 * disagreed with its cartolas before the write is reported as its own condition (`drift`), never
 * blamed on the movement.
 */
import type { Database } from "better-sqlite3";
import { db } from "./db.js";
import { getCartolaDerivedAnchor, storedCheckingLedgerAnchor } from "./checkingCartolaBalances.js";
import { cartolaClosingDay } from "./checkingCartolaMonthBounds.js";
import { InputError } from "./inputError.js";

export const CHECKING_LEDGER_CONTRADICTED = "checking_ledger_contradicted";

/** The movement contradicts the cartola of `month` (409, coded for the client's copy). */
export class CheckingLedgerContradictedError extends InputError {
  constructor(accountId: number, month: string, difference: number) {
    super(
      `This movement changes the balance of ${month}, which its cartola states (the cartola lists every movement of the month, ` +
        `and this one changes it by ${difference} CLP). If the movement is missing from the ledger, import that month's cartola ` +
        `again; if it belongs to another month, enter it on its own date.`,
      409,
      { code: CHECKING_LEDGER_CONTRADICTED, account_id: accountId, month, difference }
    );
  }
}

export type CheckingLedgerDrift = { account_id: number; stored_anchor_clp: number; derived_anchor_clp: number };

/** The first cartola month on file whose closing day is on or after `ymd` (the newest when none). */
function cartolaMonthCovering(accountId: number, ymd: string, dbHandle: Database): string {
  const months = dbHandle
    .prepare(`SELECT period_month, period_from, period_to FROM checking_cartola_imports WHERE account_id = ? ORDER BY period_month`)
    .all(accountId) as { period_month: string; period_from: string | null; period_to: string | null }[];
  return months.find((m) => cartolaClosingDay(m) >= ymd)?.period_month ?? months[months.length - 1]!.period_month;
}

/**
 * Runs `write` (a hand movement touching `accountIds`, dated `occurredOn`) in a transaction and
 * refuses it (`CheckingLedgerContradictedError`, rolled back) when it moves the derived anchor of a
 * cartola account; returns its result and the drift found before it.
 */
export function guardCheckingLedgerWrite<T>(
  accountIds: readonly number[],
  occurredOn: string,
  write: () => T,
  dbHandle: Database = db
): { result: T; drift: CheckingLedgerDrift[] } {
  return dbHandle.transaction(() => {
    const before = new Map<number, { amount_clp: number; occurred_on: string }>();
    const drift: CheckingLedgerDrift[] = [];
    for (const id of new Set(accountIds)) {
      const derived = getCartolaDerivedAnchor(id, dbHandle);
      if (derived == null) continue;
      before.set(id, derived);
      const stored = storedCheckingLedgerAnchor(id, dbHandle);
      if (stored && stored.amount_clp !== derived.amount_clp) {
        drift.push({ account_id: id, stored_anchor_clp: stored.amount_clp, derived_anchor_clp: derived.amount_clp });
      }
    }
    const result = write();
    for (const [id, b] of before) {
      const after = getCartolaDerivedAnchor(id, dbHandle);
      if (after == null || after.amount_clp !== b.amount_clp || after.occurred_on !== b.occurred_on) {
        throw new CheckingLedgerContradictedError(id, cartolaMonthCovering(id, occurredOn, dbHandle), (b.amount_clp - (after?.amount_clp ?? 0)));
      }
    }
    return { result, drift };
  })();
}
