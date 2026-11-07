/**
 * What an account holds (`docs/holdings-currency-plan.md`): its value at a date is a quantity of
 * that holding, converted once into a display unit.
 *
 * - `currency`: pesos, dollars, UF, euros (cash ledgers, checking, stored-mark accounts, the
 *   property and the mortgage).
 * - `stock`: shares of a ticker, priced in the ticker's quote currency.
 * - `coin`: a crypto coin (BTC, ETH), priced by its price series (`BTC-USD`) in dollars — the
 *   account holds the coin, the series is only where its price lives.
 * - `fund`: cuotas of a fund series (AFP, AFC, Fintual funds), priced in pesos.
 * - `card`: a credit card holds no currency of its own — it holds sub-balances, one per
 *   facturación and currency.
 *
 * Resolved with the rest of the account's profile (`accountProfile.ts`), the one place that
 * decides how an account is valued.
 */
import { accountProfile, accountProfileOptional, type Holding } from "./accountProfile.js";

export type { Holding };

/** What `accountId` holds. Memoized until the next database write. */
export function accountHolding(accountId: number): Holding {
  return accountProfile(accountId).holding;
}

/** True when the account is a credit card (no lookup that throws for a bare id). */
export function isCardAccount(accountId: number): boolean {
  return accountProfileOptional(accountId)?.quantity.kind === "card";
}
