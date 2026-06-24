import { clpToUsdAtPaymentRounded } from "./fxRates.js";

/** CLP → USD using buy rate (or mid fallback) on or before `ymd`. */
export function clpToUsdAtDate(clp: number, ymd: string): number | null {
  return clpToUsdAtPaymentRounded(clp, ymd);
}

/**
 * Gastos USD for display / aggregation: native statement USD when present,
 * otherwise CLP ÷ FX on the expense date (purchase or movement date).
 */
export function expenseGastosAmountUsdAtDate(
  amountClp: number,
  nativeUsd: number | null,
  expenseDateIso: string
): number | null {
  if (nativeUsd != null && Number.isFinite(nativeUsd) && nativeUsd !== 0) {
    return nativeUsd;
  }
  return clpToUsdAtDate(amountClp, expenseDateIso);
}
