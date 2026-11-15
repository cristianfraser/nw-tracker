import { HOME_CURRENCY, isHomeCurrency } from "nw-tracker-contracts/dto/apiConstants";
import {
  CLP_CASH_FLOW_KINDS,
  FOREIGN_CASH_FLOW_KINDS,
  brokerageFlowKindNeedsClp,
  brokerageFlowKindNeedsUsd,
  clpCashFlowKindAllowsCounterpart,
  counterpartRoleForBrokerageFlowKind,
  isOwnCurrencyFlowKind,
  type BrokerageFlowKind,
} from "./brokerageFlowKinds";
import { parseNumberInputOrThrow } from "../format";
import { type InitialMovementDraft } from "./stockAccountFormTypes";

/**
 * A cash ledger account's movement form, for the currency the account holds (the server's
 * `movement_create.cash_currency`, a code of `/api/currencies`). A peso ledger takes one pesos
 * field; a ledger in any other currency takes its own currency's field, plus the pesos spent on
 * a conversion into it.
 */

/** The kinds a cash form offers: a peso ledger's, or a foreign ledger's (conversions, dividends received). */
export function cashFlowKindsFor(currency: string): readonly BrokerageFlowKind[] {
  return isHomeCurrency(currency) ? CLP_CASH_FLOW_KINDS : FOREIGN_CASH_FLOW_KINDS;
}

/**
 * Which amount fields a cash form row shows: `pesos` (the draft's `amountClp`) and `own`, the
 * account's own foreign currency (the draft's `amountUsd`, whatever the currency).
 */
export function cashFormRowFields(kind: BrokerageFlowKind, currency: string): { pesos: boolean; own: boolean } {
  if (isHomeCurrency(currency)) return { pesos: true, own: false };
  return {
    pesos: brokerageFlowKindNeedsClp(kind),
    own: brokerageFlowKindNeedsUsd(kind) || isOwnCurrencyFlowKind(kind),
  };
}

/** A peso cash deposit or withdrawal may name the other account: one internal-transfer row. */
export function cashFormAllowsTransferCounterpart(kind: BrokerageFlowKind, currency: string): boolean {
  return isHomeCurrency(currency) && clpCashFlowKindAllowsCounterpart(kind);
}

/**
 * Body for `POST /api/accounts/:id/movements` on a cash ledger account held in `currency`.
 * Only the fields the form shows are sent, so a stale value in a hidden input never is. Throws
 * the localized message when a shown amount isn't a number (see `parseNumberInput`).
 */
export function buildCashMovementPostBody(
  row: InitialMovementDraft,
  currency: string
): Record<string, unknown> | null {
  const occurred_on = row.occurredOn.trim();
  if (!occurred_on) return null;
  const fields = cashFormRowFields(row.flowKind, currency);
  if (isHomeCurrency(currency)) {
    const amount = parseNumberInputOrThrow(row.amountClp);
    if (row.counterpartAccountId !== "" && cashFormAllowsTransferCounterpart(row.flowKind, currency)) {
      if (amount == null) return null;
      // Internal transfer leg: single from/to row, direction from the flow kind
      // (deposit = money arrives from the counterpart, withdrawal = money leaves to it).
      return {
        occurred_on,
        amount: Math.abs(amount),
        currency,
        counterpart_account_id: row.counterpartAccountId,
        counterpart_role: row.flowKind === "deposit" ? "from" : "to",
      };
    }
    return {
      occurred_on,
      flow_kind: row.flowKind,
      ...(amount != null ? { amount, currency } : {}),
    };
  }
  const pesos = fields.pesos ? parseNumberInputOrThrow(row.amountClp) : null;
  const own = fields.own ? parseNumberInputOrThrow(row.amountUsd) : null;
  return {
    occurred_on,
    flow_kind: row.flowKind,
    // A kind showing both fields (a conversion) sends the pesos spent as the amount and the
    // account's currency bought as the counter leg.
    ...(pesos != null
      ? {
          amount: pesos,
          currency: HOME_CURRENCY,
          ...(own != null ? { counter_amount: own, counter_currency: currency } : {}),
        }
      : own != null
        ? { amount: own, currency }
        : {}),
    ...(row.counterpartAccountId !== ""
      ? {
          counterpart_account_id: row.counterpartAccountId,
          counterpart_role: counterpartRoleForBrokerageFlowKind(row.flowKind, "cash"),
        }
      : {}),
  };
}
