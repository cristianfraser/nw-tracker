/**
 * Cash held in a foreign currency (docs/any-currency-plan.md Phase C1): a cash ledger account
 * whose currency is not pesos (`cashCurrency.ts`: the dollar accounts, a euro account). Its balance
 * is the sum of its movements' legs in that currency; its value in a display unit is that balance
 * converted once (`valueConvert.ts`).
 */
import { BID_ASK_FOREIGN_CURRENCY, fxSellClpPerUsdOnOrBefore } from "./fxBidAsk.js";
import { fxRowOnOrBefore } from "./fxRates.js";
import { recordFxConversionWarning } from "./fxConversionWarnings.js";
import { sumNativeThroughDisplayDate } from "./movementTransfer.js";
import { foreignCashCurrencyOf } from "./cashCurrency.js";
import { roundToCurrency } from "./displayUnits.js";
import { convertValue } from "./valueConvert.js";

export {
  foreignCashCurrencyOf,
  isForeignCashAccount,
  isForeignCashAccountIn,
  isForeignCashKindSlug,
} from "./cashCurrency.js";

/** The account's foreign currency; throws when it is not a foreign cash ledger. */
export function requireForeignCashCurrency(accountId: number): string {
  const c = foreignCashCurrencyOf(accountId);
  if (c == null) throw new Error(`account ${accountId} is not a foreign cash account`);
  return c;
}

/**
 * Display balance at `asOfYmd`, in the account's own currency, rounded to its smallest coin:
 * strict by bank date before today, every known movement from today on (a forward-posted row
 * counts now — `displayLedgerCutoffYmd`).
 */
export function foreignCashBalanceAt(accountId: number, asOfYmd: string): number {
  const currency = requireForeignCashCurrency(accountId);
  return roundToCurrency(sumNativeThroughDisplayDate(accountId, asOfYmd, currency), currency);
}

/**
 * An amount of a foreign currency in pesos at the cash valuation rate on or before `asOfYmd`
 * (what selling it would get): the stored sell rate for the dollar (its `fx_daily` mid, with a
 * warning, while none is stored), the walk's asset side for any other currency. Rounded to the peso.
 */
export function foreignCashToClpAt(amount: number, currency: string, asOfYmd: string, context: string): number {
  if (currency === BID_ASK_FOREIGN_CURRENCY) {
    const sell = fxSellClpPerUsdOnOrBefore(asOfYmd);
    if (sell != null && sell > 0) return Math.round(amount * sell);
    const fx = fxRowOnOrBefore(asOfYmd);
    if (!fx) {
      throw new Error(`fx_daily missing on or before ${asOfYmd} for ${context}`);
    }
    recordFxConversionWarning({ code: "sell_rate_missing", date: asOfYmd, context });
    return Math.round(amount * fx.clp_per_usd);
  }
  const clp = convertValue(amount, currency, "clp", asOfYmd, "asset");
  if (clp == null) throw new Error(`no ${currency}/CLP rate on or before ${asOfYmd} for ${context}`);
  return Math.round(clp);
}
