/**
 * The money equality of the matchers: two amounts are the same money when they are the same number
 * of the currency's smallest coin (a peso, a cent) — whatever the currency, so no matcher carries a
 * «pesos to the unit, dollars to the cent» branch of its own.
 */
import { roundToCurrency } from "../displayUnits.js";

/** `a` and `b`, both in `currency`, agree to its smallest coin. */
export function sameCoin(a: number, b: number, currency: string): boolean {
  return roundToCurrency(a, currency) === roundToCurrency(b, currency);
}
