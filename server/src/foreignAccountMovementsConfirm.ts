import { isForeignCashAccountIn } from "./foreignCashAccounts.js";
import type { BankAccountMovement, ForeignAccountMovementsApplyDetails } from "nw-tracker-contracts";


import { claimTransferLegForBankRow, findMatchingTransferLegId } from "./checkingTransferLegReconcile.js";
import { db } from "./db.js";
import { createImportBatch } from "./importBatches.js";


/**
 * A foreign-currency bank account's recent movements (`bank_account.movements` in a currency other
 * than pesos; the Santander dollar account since 2026-10-10, any currency since 2026-11-12)
 * CONFIRM the ledger and never insert, in the listing's currency to its coin. Every row the dollar cuenta corriente can show is already on
 * file from its own document before the bank lists it: a broker's dollar withdrawal is booked
 * from the wire's notices (`incomingWires.ts`), a card payment from the dollar account is
 * entered by hand (`ccManualPayments.ts`), a conversion to pesos is a transfer the user writes.
 * So the listing is read as evidence, like the peso xlsx against a transfer leg: a row a
 * transfer leg on the account explains to the coin (`findMatchingTransferLegId`, the same
 * posting window) is `confirmed` and the bank's posting day recorded; a credit the bank files as
 * an incoming wire (`wire_reference`) whose booking has not landed yet is `awaiting_wire_booking`
 * (the next run brings it again; the wire step itself raises the alarm when the notices never
 * come); any other row is `unexplained` — reported, never written, and the feeder fails its step
 * on it, since a dollar row the app does not know about is a row to enter, not to guess at.
 *
 * Re-sending a listing is idempotent: a leg whose posting day is recorded matches that day again.
 * The import batch (`foreign_account_feed`) names the account and the currency it is held in.
 */
export function confirmForeignAccountMovements(
  accountId: number,
  currency: string,
  movements: BankAccountMovement[],
  sourceRef: string
): ForeignAccountMovementsApplyDetails {
  if (!isForeignCashAccountIn(accountId, currency)) {
    throw new Error(`account ${accountId} is not a ${currency.toUpperCase()} cash account`);
  }
  const consumed = new Set<number>();
  const confirmed_flows: ForeignAccountMovementsApplyDetails["confirmed_flows"] = [];
  const awaiting_flows: ForeignAccountMovementsApplyDetails["awaiting_flows"] = [];
  const unexplained_flows: ForeignAccountMovementsApplyDetails["unexplained_flows"] = [];
  let earliestConfirmed: string | null = null;
  db.transaction(() => {
    for (const mv of movements) {
      if (mv.currency !== currency) {
        throw new Error(`a ${mv.currency} row in a ${currency.toUpperCase()} account's listing (${mv.date} ${mv.description})`);
      }
      const legId = findMatchingTransferLegId(accountId, currency, mv.date, mv.amount, consumed);
      if (legId != null) {
        consumed.add(legId);
        claimTransferLegForBankRow(legId, accountId, mv.date);
        confirmed_flows.push({ occurred_on: mv.date, description: mv.description, amount: mv.amount, movement_id: legId });
        if (earliestConfirmed === null || mv.date < earliestConfirmed) earliestConfirmed = mv.date;
        continue;
      }
      if (mv.wire_reference !== null && mv.amount > 0) {
        awaiting_flows.push({ occurred_on: mv.date, description: mv.description, amount: mv.amount, wire_reference: mv.wire_reference });
        continue;
      }
      unexplained_flows.push({ occurred_on: mv.date, description: mv.description, amount: mv.amount });
    }
  })();
  const batch_id = createImportBatch("foreign_account_feed", sourceRef, {
    format: "current_account_transactions",
    account_id: accountId,
    currency,
    confirmed: confirmed_flows.length,
    awaiting_wire_booking: awaiting_flows.length,
    unexplained: unexplained_flows.length,
    unexplained_flows,
  });
  return {
    account_id: accountId,
    batch_id,
    confirmed: confirmed_flows.length,
    awaiting_wire_booking: awaiting_flows.length,
    unexplained: unexplained_flows.length,
    confirmed_flows,
    awaiting_flows,
    unexplained_flows,
  };
}
