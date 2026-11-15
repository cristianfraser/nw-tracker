/**
 * Cash held in a foreign currency (docs/any-currency-plan.md Phase C1): a cash ledger account
 * whose currency is not pesos (`cashCurrency.ts`: the dollar accounts, a euro account). Its balance
 * is the sum of its movements' legs in that currency; its value in a display unit is that balance
 * converted once (`valueConvert.ts`).
 */
import { pairBidAskOnOrBefore, pairKeepsBidAsk, storedPairRate } from "./rates.js";
import { recordFxConversionWarning } from "./fxConversionWarnings.js";
import { sumNativeThroughDisplayDate } from "./movementTransfer.js";
import { foreignCashCurrencyOf } from "./cashCurrency.js";
import { HOME_CURRENCY, roundToCurrency } from "./displayUnits.js";
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
 * (what selling it would get). A currency whose peso pair keeps buy and sell rates on file reads
 * the stored sell rate (the pair's mid, with a warning, while none is stored); any other reads the
 * walk's asset side. Rounded to the peso.
 */
export function foreignCashToClpAt(amount: number, currency: string, asOfYmd: string, context: string): number {
  if (pairKeepsBidAsk(currency, HOME_CURRENCY)) {
    const sell = pairBidAskOnOrBefore(currency, HOME_CURRENCY, asOfYmd)?.bid;
    if (sell != null) return Math.round(amount * sell);
    const fx = storedPairRate(currency, HOME_CURRENCY, asOfYmd);
    if (!fx) {
      throw new Error(`no ${currency}/${HOME_CURRENCY} rate on or before ${asOfYmd} for ${context}`);
    }
    recordFxConversionWarning({ code: "sell_rate_missing", date: asOfYmd, context });
    return Math.round(amount * fx.mid);
  }
  const clp = convertValue(amount, currency, HOME_CURRENCY, asOfYmd, "asset");
  if (clp == null) throw new Error(`no ${currency}/${HOME_CURRENCY} rate on or before ${asOfYmd} for ${context}`);
  return Math.round(clp);
}
