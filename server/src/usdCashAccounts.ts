import { chileCalendarTodayYmd } from "./chileDate.js";
import { fxRowOnOrBefore } from "./fxRates.js";
import { isUsdCashAccount, sumUsdThroughDate } from "./movementTransfer.js";

export { isUsdCashAccount, isUsdCashKindSlug } from "./movementTransfer.js";

export function usdCashBalanceUsdAt(accountId: number, asOfYmd: string): number {
  if (!isUsdCashAccount(accountId)) {
    throw new Error(`account ${accountId} is not a USD cash account`);
  }
  const balance = sumUsdThroughDate(accountId, asOfYmd);
  return Math.round(balance * 100) / 100;
}

export function usdCashBalanceClpAt(accountId: number, asOfYmd: string): number {
  const usd = usdCashBalanceUsdAt(accountId, asOfYmd);
  const fx = fxRowOnOrBefore(asOfYmd);
  if (!fx) {
    throw new Error(`fx_daily missing on or before ${asOfYmd} for USD cash account ${accountId}`);
  }
  return Math.round(usd * fx.clp_per_usd);
}

export function usdCashBalanceLive(accountId: number): { value_usd: number; value_clp: number; as_of_date: string } {
  const asOf = chileCalendarTodayYmd();
  const value_usd = usdCashBalanceUsdAt(accountId, asOf);
  const value_clp = usdCashBalanceClpAt(accountId, asOf);
  return { value_usd, value_clp, as_of_date: asOf };
}
