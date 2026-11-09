/**
 * An account's VALUE in a display unit (`docs/holdings-currency-plan.md`): a quantity of what it
 * holds (`accountHoldingQtyAt`), priced when it is an instrument (`holdingPriceAt`), converted
 * once into the unit at the side of the spread that closes it (`valueConvert.ts`: an asset at
 * what selling it would get, a liability at what buying it back would cost). Nothing is built in
 * pesos first and converted back: a dollar stock in dollars is shares × its dollar price, dollar
 * cash in dollars is its ledger, a peso fund in dollars is cuotas × its peso price at the day's
 * rate.
 *
 * Today reads the account's one today value (`accountTodayValue`, whose native value carries the
 * live price) at today's rate; any other day reads what the account held that day
 * (`accountHistoricalQtyMark`). Until their own phases the card's owed walk and the depto
 * ledger's figures are peso quantities.
 */
import {
  accountHistoricalQtyMark,
  accountValueSide,
  qtyMarkValueIn,
  type QtyMark,
} from "./accountMarkClpAtYmd.js";
import { accountProfileOptional } from "./accountProfile.js";
import { accountTodayValue, todayValueInUnit } from "./accountTodayValue.js";
import { equityShareUnitsThroughYmd } from "./brokerageEquityMtm.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { cryptoCoinCumulativeThroughDate } from "./cryptoValuation.js";
import { afpCuotasCumulativeThroughDate } from "./afpUnoValuation.js";
import { fintualGoalUnitsFromMovementsThroughDate } from "./fintualGoalUnits.js";
import type { Holding } from "./holdings.js";
import type { CurrencyCode } from "./rates.js";
import { usdCashBalanceUsdAt } from "./usdCashAccounts.js";
import { convertValue } from "./valueConvert.js";
import { cardValueInUnit } from "./cardValueInUnit.js";

export type AccountValueOpts = { now?: Date };

/**
 * The currency an account's value is natively expressed in: dollars for a dollar ledger, a
 * dollar-quoted stock, a coin or a fund on a dollar series; pesos for everything else — peso
 * ledgers, peso funds and, until their own phases, the card and the depto ledger.
 */
export function accountValueCurrency(accountId: number): CurrencyCode {
  // An id with no account row behind it (a synthetic chart line) holds pesos.
  const h = accountProfileOptional(accountId)?.holding;
  if (!h) return "clp";
  if (h.kind === "currency") return h.code === "usd" || h.code === "eur" ? h.code : "clp";
  if (h.kind === "stock") return h.quote;
  if (h.kind === "coin") return h.quote;
  if (h.kind === "fund") return h.quote;
  return "clp";
}

/**
 * What `accountId` held on `ymd`: a quantity and what it is of. A day other than today is the
 * quantity the valuation stack reads (falling through to a peso mark where it always has, e.g.
 * before a fund's price series starts). Today: the shares, coins or cuotas held, the dollar
 * ledger's dollars, and for every other account its today value as a peso quantity.
 */
export function accountHoldingQtyAt(
  accountId: number,
  ymd: string,
  opts?: AccountValueOpts
): { qty: number; holding: Holding; as_of: string } | null {
  const now = opts?.now;
  const today = chileCalendarTodayYmd();
  if (ymd !== today) {
    const m: QtyMark | null = accountHistoricalQtyMark(accountId, ymd);
    return m ? { qty: m.qty, holding: m.asset, as_of: m.as_of_date } : null;
  }
  const profile = accountProfileOptional(accountId);
  if (!profile) return null;
  const holding = profile.holding;
  if (holding.kind === "currency" && holding.code === "usd") {
    return { qty: usdCashBalanceUsdAt(accountId, today), holding, as_of: today };
  }
  if (holding.kind === "stock") return { qty: equityShareUnitsThroughYmd(accountId, today), holding, as_of: today };
  if (holding.kind === "coin") return { qty: cryptoCoinCumulativeThroughDate(accountId, today), holding, as_of: today };
  if (holding.kind === "fund") {
    const cuotas = profile.quantity.kind === "cuota_ledger"
      ? afpCuotasCumulativeThroughDate(accountId, today)
      : fintualGoalUnitsFromMovementsThroughDate(accountId, today) ?? 0;
    return { qty: cuotas, holding, as_of: today };
  }
  const v = accountTodayValue(accountId, { now });
  if (!v) return null;
  return { qty: v.native_value, holding: { kind: "currency", code: v.native_currency }, as_of: v.as_of_date };
}

/**
 * The account's value on `ymd` in `unit`, converted once at its side. Null without a value or a
 * rate on file.
 */
export function accountValueAt(
  accountId: number,
  ymd: string,
  unit: CurrencyCode,
  opts?: AccountValueOpts
): { value: number; as_of_date: string } | null {
  const now = opts?.now;
  if (ymd === chileCalendarTodayYmd()) {
    const v = accountTodayValue(accountId, { now });
    if (!v) return null;
    const value = todayValueInUnit(accountId, v, unit, now);
    return value != null && Number.isFinite(value) ? { value, as_of_date: v.as_of_date } : null;
  }
  const mark = accountHistoricalQtyMark(accountId, ymd);
  if (!mark) return null;
  // A past day reads stored prices and rates only (memoized); `now` matters from today on.
  const value = qtyMarkValueIn(
    accountId,
    mark,
    ymd,
    unit,
    accountValueSide(accountId),
    ymd < chileCalendarTodayYmd() ? undefined : now
  );
  return value != null && Number.isFinite(value) ? { value, as_of_date: mark.as_of_date } : null;
}

/**
 * An account's value in `unit`, given its pesos `clp` at `ymd`. A value natively in pesos is
 * those pesos converted once at the account's side; one natively in another currency (dollar
 * cash, a dollar stock, a coin) is re-read in that currency and converted from it — never from
 * the pesos, which would read the spread or another day's rate as a P/L.
 */
export function accountValueInUnitFromClp(
  accountId: number,
  clp: number,
  ymd: string,
  unit: CurrencyCode,
  opts?: { now?: Date }
): number | null {
  if (unit === "clp") return clp;
  if (accountProfileOptional(accountId)?.quantity.kind === "card") return cardValueInUnit(accountId, clp, ymd, unit, opts?.now);
  if (accountValueCurrency(accountId) === "clp") {
    return convertValue(clp, "clp", unit, ymd, accountValueSide(accountId), opts?.now);
  }
  return accountValueAt(accountId, ymd, unit, opts)?.value ?? null;
}
