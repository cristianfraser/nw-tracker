/**
 * THE seam where a credit card's value is put in a display unit. Every reader of a card's value
 * in a unit — its historical mark (`accountMarkClpAtYmd`), the daily quantity series
 * (`accountMarkDailyCache.ts`), its today value (`accountTodayValue`) and a value handed in
 * pesos (`accountValueInUnitFromClp`) — comes through here.
 *
 * A card holds sub-balances per currency (`ccOwedByCurrencyAtYmd`): each converts on its own,
 * at the debt side while owed and the asset side while in credit, so a card in USD reads its
 * dollars as dollars, never pesos ÷ a rate. `owedClp` is the card's owed in pesos (the same
 * sub-balances at the date's rate): a card with no walk on file is that peso figure alone.
 */
import { isHomeCurrency } from "./displayUnits.js";
import { ccOwedByCurrencyAtYmd } from "./ccOwedWalk.js";
import { convertValue } from "./valueConvert.js";
import type { CurrencyCode } from "./rates.js";

function subBalanceIn(qty: number, from: CurrencyCode, unit: CurrencyCode, ymd: string, now?: Date): number | null {
  return convertValue(qty, from, unit, ymd, qty < 0 ? "asset" : "debt", now);
}

export function cardValueInUnit(
  accountId: number,
  owedClp: number,
  ymd: string,
  unit: CurrencyCode,
  now?: Date
): number | null {
  if (isHomeCurrency(unit)) return owedClp;
  const mark = ccOwedByCurrencyAtYmd(accountId, ymd);
  if (mark == null) return subBalanceIn(owedClp, "clp", unit, ymd, now);
  let sum = 0;
  for (const [c, qty] of Object.entries(mark.owed)) {
    const v = subBalanceIn(qty, c, unit, ymd, now);
    if (v == null) return null;
    sum += v;
  }
  return sum;
}
