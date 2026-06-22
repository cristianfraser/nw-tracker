import { fxRowOnOrBefore } from "./fxRates.js";

/** CLP → USD using `fx_daily` on or before `ymd`. */
export function clpToUsdAtDate(clp: number, ymd: string): number | null {
  if (!Number.isFinite(clp) || clp === 0) return clp === 0 ? 0 : null;
  const fx = fxRowOnOrBefore(ymd);
  if (!fx || fx.clp_per_usd <= 0) return null;
  return clp / fx.clp_per_usd;
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
