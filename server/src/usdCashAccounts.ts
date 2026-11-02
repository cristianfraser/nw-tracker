import { fxSellClpPerUsdOnOrBefore } from "./fxBidAsk.js";
import { fxRowOnOrBefore } from "./fxRates.js";
import { recordFxConversionWarning } from "./fxConversionWarnings.js";
import { isUsdCashAccount, sumUsdThroughDisplayDate } from "./movementTransfer.js";
import { convertValue } from "./valueConvert.js";

export { isUsdCashAccount, isUsdCashKindSlug } from "./movementTransfer.js";

/**
 * Display balance at `asOfYmd`: strict by bank date before today, every known movement from
 * today on (a forward-posted row counts now — `displayLedgerCutoffYmd`).
 */
export function usdCashBalanceUsdAt(accountId: number, asOfYmd: string): number {
  if (!isUsdCashAccount(accountId)) {
    throw new Error(`account ${accountId} is not a USD cash account`);
  }
  const balance = sumUsdThroughDisplayDate(accountId, asOfYmd);
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

/**
 * The account's dollars in pesos at `asOfYmd`, at what selling them would get (`valueConvert.ts`):
 * the stored sell rate on a past day, the live rate today while the fx day is open. A zero
 * balance needs no rate (consolidation baselines mark every account at every month-end,
 * including dates before fx history starts). Throws without a rate on file.
 */
export function usdCashBalanceClpAt(accountId: number, asOfYmd: string): number {
  const usd = usdCashBalanceUsdAt(accountId, asOfYmd);
  if (usd === 0) return 0;
  const clp = convertValue(usd, "usd", "clp", asOfYmd, "asset");
  if (clp == null) throw new Error(`usdCashBalanceClpAt: no USD/CLP rate on or before ${asOfYmd} (account ${accountId})`);
  return clp;
}
