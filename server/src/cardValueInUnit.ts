/**
 * THE seam where a credit card's value is put in a display unit. Every reader of a card's value
 * in a unit — its historical mark (`accountMarkClpAtYmd`), the daily quantity series
 * (`accountMarkDailyCache.ts`), its today value (`accountTodayValue`) and a value handed in
 * pesos (`accountValueInUnitFromClp`) — comes through here.
 *
 * Today the card's owed is a peso quantity (the owed walk, already in pesos) converted at the
 * debt side. The card phase (sub-balances per currency, `ccOwedByCurrencyAtYmd`) replaces the
 * body: a card in USD must read its dollars as dollars, never pesos ÷ a rate.
 */
import { convertValue } from "./valueConvert.js";
import type { CurrencyCode } from "./rates.js";

export function cardValueInUnit(
  _accountId: number,
  owedClp: number,
  ymd: string,
  unit: CurrencyCode,
  now?: Date
): number | null {
  return convertValue(owedClp, "clp", unit, ymd, "debt", now);
}
