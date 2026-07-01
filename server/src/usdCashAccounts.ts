import { chileCalendarTodayYmd } from "./chileDate.js";
import { fxSellClpPerUsdOnOrBefore } from "./fxBidAsk.js";
import { fxRowOnOrBefore } from "./fxRates.js";
import { recordFxConversionWarning } from "./fxConversionWarnings.js";
import { isUsdCashAccount, sumUsdThroughDate } from "./movementTransfer.js";

export { isUsdCashAccount, isUsdCashKindSlug } from "./movementTransfer.js";

export function usdCashBalanceUsdAt(accountId: number, asOfYmd: string): number {
  if (!isUsdCashAccount(accountId)) {
    throw new Error(`account ${accountId} is not a USD cash account`);
  }
  const balance = sumUsdThroughDate(accountId, asOfYmd);
  return Math.round(balance * 100) / 100;
}

/** CLP-per-USD rate used for USD cash valuation (sell rate, else fx_daily mid). */
export function usdCashClpRateOnOrBefore(asOfYmd: string, context: string): number {
  const sell = fxSellClpPerUsdOnOrBefore(asOfYmd);
  if (sell != null && sell > 0) return sell;
  const fx = fxRowOnOrBefore(asOfYmd);
  if (!fx) {
    throw new Error(`fx_daily missing on or before ${asOfYmd} for ${context}`);
  }
  recordFxConversionWarning({ code: "sell_rate_missing", date: asOfYmd, context });
  return fx.clp_per_usd;
}

/** Convert a USD amount to CLP at the USD-cash valuation rate (same rate as the balance). */
export function usdCashUsdToClpAt(usd: number, asOfYmd: string, context: string): number {
  return Math.round(usd * usdCashClpRateOnOrBefore(asOfYmd, context));
}

export function usdCashBalanceClpAt(accountId: number, asOfYmd: string): number {
  const usd = usdCashBalanceUsdAt(accountId, asOfYmd);
  return usdCashUsdToClpAt(usd, asOfYmd, `usdCashBalanceClpAt:${accountId}`);
}

export function usdCashBalanceLive(accountId: number): { value_usd: number; value_clp: number; as_of_date: string } {
  const asOf = chileCalendarTodayYmd();
  const value_usd = usdCashBalanceUsdAt(accountId, asOf);
  const value_clp = usdCashBalanceClpAt(accountId, asOf);
  return { value_usd, value_clp, as_of_date: asOf };
}
