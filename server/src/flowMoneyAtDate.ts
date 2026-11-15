import { convertFlowOrNull, roundReferenceAmount } from "./rates.js";

/** CLP → USD at the buy rate on or before `ymd` (a flow, `convertFlowOrNull`), kept at 5 decimals. */
export function clpToUsdAtDate(clp: number, ymd: string): number | null {
  if (!Number.isFinite(clp)) return 0;
  const usd = convertFlowOrNull(clp, "clp", "usd", ymd);
  return usd == null ? null : roundReferenceAmount(usd);
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
