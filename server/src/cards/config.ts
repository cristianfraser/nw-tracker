/**
 * A card master's configured billing cycle (`credit_card_account_config`), read in one place. The
 * config cycle is the open buckets' identity (`statementCloseDdMmYyyyForBillingMonth`) and the
 * close estimate of a card with no close on record; which facturación a purchase belongs to is the
 * bank's (`billingMonthContainingPurchase`). Every card master has a config row: an account without
 * one is not a card (a routing bug) and throws — the old reader answered a default 21→20 cycle.
 * A stored NULL end day reads as the 20th, as billing math always took it.
 */
import { db } from "../db.js";

export type CreditCardBillingConfig = {
  billing_cycle_start_day: number;
  billing_cycle_end_day: number | null;
};

const stmtConfig = db.prepare(
  `SELECT billing_cycle_start_day, billing_cycle_end_day
   FROM credit_card_account_config WHERE account_id = ?`
);

/** The config cycle's end day when the column is NULL. */
export const DEFAULT_BILLING_CYCLE_END_DAY = 20;

export function loadCreditCardBillingConfig(accountId: number): CreditCardBillingConfig {
  const row = stmtConfig.get(accountId) as
    | { billing_cycle_start_day: number; billing_cycle_end_day: number | null }
    | undefined;
  if (!row) throw new Error(`Account ${accountId} is not a card master (no credit_card_account_config row)`);
  return {
    billing_cycle_start_day: row.billing_cycle_start_day,
    billing_cycle_end_day: row.billing_cycle_end_day ?? DEFAULT_BILLING_CYCLE_END_DAY,
  };
}
