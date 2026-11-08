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

/** A card master's config row as stored. */
export type CreditCardConfigRow = {
  card_last4: string | null;
  billing_cycle_start_day: number;
  billing_cycle_end_day: number | null;
  cupo_clp: number | null;
  cupo_usd: number | null;
};

const stmtConfig = db.prepare(
  `SELECT card_last4, billing_cycle_start_day, billing_cycle_end_day, cupo_clp, cupo_usd
   FROM credit_card_account_config WHERE account_id = ?`
);

/** The card master's config row; an account without one is not a card master and throws. */
export function loadCreditCardConfigRow(accountId: number): CreditCardConfigRow {
  const row = stmtConfig.get(accountId) as CreditCardConfigRow | undefined;
  if (!row) throw new Error(`Account ${accountId} is not a card master (no credit_card_account_config row)`);
  return row;
}

/** The config cycle's end day when the column is NULL. */
export const DEFAULT_BILLING_CYCLE_END_DAY = 20;

export function loadCreditCardBillingConfig(accountId: number): CreditCardBillingConfig {
  const row = loadCreditCardConfigRow(accountId);
  return {
    billing_cycle_start_day: row.billing_cycle_start_day,
    billing_cycle_end_day: row.billing_cycle_end_day ?? DEFAULT_BILLING_CYCLE_END_DAY,
  };
}

/** The card master whose configured titular plastic (`credit_card_account_config.card_last4`) is `last4`. */
export function resolveMasterAccountIdForCardLast4(last4: string): number | null {
  const l4 = String(last4 ?? "").trim();
  if (!l4) return null;
  const row = db
    .prepare(
      `SELECT a.id
       FROM accounts a
       JOIN credit_card_account_config c ON c.account_id = a.id
       WHERE c.card_last4 = ?
       LIMIT 1`
    )
    .get(l4) as { id: number } | undefined;
  // `credit_card_account_config.card_last4` is the card identity — a master without a config row
  // is a data problem, not a case for note archaeology.
  return row?.id ?? null;
}
