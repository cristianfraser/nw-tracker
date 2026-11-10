/**
 * Interest credited in a window: every `savings_earnings` movement on an account (a bank account's
 * interest, a broker's sweep, a savings account's earnings), in the currency it was credited in,
 * with the payers behind the account (`payers.ts`). No conversion, no reajuste, no code.
 */
import { db } from "../db.js";
import type { DateWindow } from "../dateWindow.js";
import { loadAccountPayers, type AccountPayer } from "./payers.js";

export type InterestFact = {
  movementId: number;
  date: string;
  accountId: number;
  currency: string;
  /** As credited, in `currency` (positive: earned). */
  amount: number;
  /** Who stands behind the account; empty when no broker role or bank number names one. */
  payers: AccountPayer[];
};

/** The window's interest, by date then movement id. */
export function interestFacts(window: DateWindow): InterestFact[] {
  const payers = loadAccountPayers();
  const rows = db
    .prepare(
      `SELECT id, account_id, occurred_on, amount, currency FROM movements
        WHERE flow_kind = 'savings_earnings' AND account_id IS NOT NULL AND occurred_on >= ? AND occurred_on <= ?
        ORDER BY occurred_on, id`
    )
    .all(window.fromYmd, window.throughYmd) as { id: number; account_id: number; occurred_on: string; amount: number; currency: string }[];
  return rows.map((r) => ({
    movementId: r.id,
    date: r.occurred_on,
    accountId: r.account_id,
    currency: r.currency,
    amount: r.amount,
    payers: payers.get(r.account_id) ?? [],
  }));
}
