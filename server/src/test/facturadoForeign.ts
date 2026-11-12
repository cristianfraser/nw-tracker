import type { CcFacturadoForeign } from "../ccBillingViews.js";

/** A facturación row's `facturado_foreign` for a card that bills pesos and dollars (tests). */
export function usdForeign(
  amount: number | null,
  clp: number | null,
  rate_clp: number | null = null,
  rate_source: CcFacturadoForeign["rate_source"] = null
): CcFacturadoForeign[] {
  return [{ currency: "usd", amount, clp, rate_clp, rate_source }];
}
