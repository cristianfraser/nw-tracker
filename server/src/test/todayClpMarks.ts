/**
 * Today's mark of a stock or coin position in pesos, as the tests read it: the production
 * native value (`equityTodayNativeValue` / `cryptoTodayNativeValue`) converted at today's sell
 * rate. Production converts through `accountTodayValue`; these are for assertions only.
 */
import { equityTodayNativeValue } from "../brokerageEquityMtm.js";
import { cryptoTodayNativeValue } from "../cryptoValuation.js";
import { chileWallClockAt } from "../chileDate.js";
import { convertValue } from "../valueConvert.js";

export function equityTodayClp(
  accountId: number,
  now: Date = new Date()
): { value_clp: number; as_of_date: string } | null {
  const native = equityTodayNativeValue(accountId, now);
  if (!native) return null;
  const clp = convertValue(native.value, native.currency, "clp", chileWallClockAt(now).ymd, "asset", now);
  return clp != null && Number.isFinite(clp) ? { value_clp: clp, as_of_date: native.as_of_date } : null;
}

export function cryptoTodayClp(
  accountId: number,
  now: Date = new Date()
): { value_clp: number; as_of_date: string } | null {
  const native = cryptoTodayNativeValue(accountId, now);
  if (!native) return null;
  const clp = convertValue(native.value, "usd", "clp", chileWallClockAt(now).ymd, "asset", now);
  return clp != null && Number.isFinite(clp) ? { value_clp: clp, as_of_date: native.as_of_date } : null;
}
