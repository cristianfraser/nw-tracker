import { convertCurrency } from "./rates.js";
import { HOME_CURRENCY, isHomeCurrency } from "./displayUnits.js";

/**
 * CLP per unit of a foreign currency, by currency code, standing in for every debt-frame rate of
 * that currency: the anchor writer builds the statement frame with them to split a balance into
 * its peso part and one part per foreign currency (the balance is affine in each rate —
 * `ccStatementOwedByCurrencyByMonth` in `ccBillingViews.ts`). Passed down the call chain to the
 * functions that convert; absent, they read the real debt-frame rates. A currency with no entry
 * keeps its real rate.
 */
export type DebtFrameRates = ReadonlyMap<string, number>;

/** No stand-in rates: every conversion reads the real debt-frame rate. What a reader outside a split pass hands down. */
export const REAL_DEBT_FRAME_RATES: DebtFrameRates | undefined = undefined;

/** {@link DebtFrameRates} from its entries; every rate must be positive. */
export function debtFrameRates(entries: Iterable<readonly [string, number]>): DebtFrameRates {
  const rates = new Map<string, number>();
  for (const [currency, rate] of entries) {
    if (!(rate > 0)) throw new Error(`debtFrameRates: bad ${currency} rate ${rate}`);
    rates.set(currency, rate);
  }
  return rates;
}

/**
 * CLP per unit of `currency` for valuing it as card debt in the statement frame: the stored close
 * on or before `fxDateIso` (the facturación's pay-by − 1, `balanceUsdFxDateIso`) through
 * `rates.ts` — what the document is priced at, never a live rate —, or the currency's rate in
 * `rates` when given. Null when no rate is on file. One path for every currency.
 */
export function debtFrameClpPerUnit(currency: string, fxDateIso: string | null, rates?: DebtFrameRates): number | null {
  if (isHomeCurrency(currency)) return 1;
  const given = rates?.get(currency);
  if (given != null) return given;
  if (!fxDateIso) return null;
  const r = convertCurrency(1, currency, HOME_CURRENCY, fxDateIso, { side: "mid", storedOnly: true });
  return r != null && r > 0 ? r : null;
}

/**
 * Whole pesos of `amount` of `currency` in the statement frame ({@link debtFrameClpPerUnit}).
 * An amount of zero is zero; an amount with no rate on file THROWS, naming `what` — a sum that
 * skipped it would read the debt short without saying so.
 */
export function debtFrameClp(
  amount: number,
  currency: string,
  fxDateIso: string | null,
  rates: DebtFrameRates | undefined,
  what: string
): number {
  if (!Number.isFinite(amount)) throw new Error(`${what}: not an amount (${amount})`);
  if (amount === 0) return 0;
  const rate = debtFrameClpPerUnit(currency, fxDateIso, rates);
  if (rate == null) {
    throw new Error(`${what}: no ${currency.toUpperCase()}/${HOME_CURRENCY.toUpperCase()} rate on or before ${fxDateIso ?? "an unknown date"}`);
  }
  return Math.round(amount * rate);
}

/**
 * The pesos a statement line bills in a statement-frame DEBT sum: its pesos as stored, a foreign
 * amount through {@link debtFrameClp} (the facturación's pay-by − 1, or the rates of a split
 * pass). Null only when the line bills nothing (a missing or zero amount); a foreign amount with
 * no rate throws. Import dedupe and line matching keep {@link cardLineAmountClpAtStoredRate}: a
 * split pass must not change which lines match.
 */
export function debtCardLineAmountClp(
  row: CcLineNativeInput,
  fxDateIso: string | null,
  rates: DebtFrameRates | undefined,
  what: string
): number | null {
  return cardLineAmountClpWith(row, (amount, currency) => debtFrameClp(amount, currency, fxDateIso, rates, what));
}

/**
 * The pesos a statement line bills at the stored close on or before `fxDateIso`: for comparing
 * amounts (import dedupe, plan matching at the statement date). Null when the line bills nothing
 * or no rate is on file — a line that cannot be priced matches nothing.
 */
export function cardLineAmountClpAtStoredRate(row: CcLineNativeInput, fxDateIso: string | null): number | null {
  return cardLineAmountClpWith(row, (amount, currency) => {
    const rate = debtFrameClpPerUnit(currency, fxDateIso);
    return rate == null ? null : Math.round(amount * rate);
  });
}

/** A statement line as its stored columns state it (migration 319). */
export type CcLineNativeInput = {
  installment_flag: number;
  amount: number | null;
  currency: string;
  cuota_amount: number | null;
};

/**
 * What a statement line bills, in its own currency: a cuota line its cuota, any other line its
 * amount; null when that is missing or zero. A line is in one currency.
 */
export function cardLineNativeAmount(row: CcLineNativeInput): { amount: number; currency: string } | null {
  const v = row.installment_flag === 1 ? row.cuota_amount : row.amount;
  if (v == null || !Number.isFinite(v) || v === 0) return null;
  return { amount: v, currency: row.currency };
}

/**
 * The pesos a statement line bills: its pesos as stored, or its foreign amount through
 * `toClp(amount, currency)` (only called with a finite, non-zero amount).
 */
export function cardLineAmountClpWith(
  row: CcLineNativeInput,
  toClp: (amount: number, currency: string) => number | null
): number | null {
  const native = cardLineNativeAmount(row);
  if (!native) return null;
  return isHomeCurrency(native.currency) ? Math.round(native.amount) : toClp(native.amount, native.currency);
}
