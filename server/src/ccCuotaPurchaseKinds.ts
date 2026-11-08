/**
 * Cuota purchases as the Santander card feed types them (2026-09-26, migration 186).
 *
 * The unbilled-movements feed lists a purchase made in cuotas at its full principal and types it
 * in `Descripcion`. The type decides when cuota 1 bills — evidence from every Santander plan on
 * the 2026 statements:
 *   - «CUOTA COMERCIO» (merchant-financed): the purchase cycle's statement prints it as cuota 00/N
 *     and cuota 1 bills at the NEXT close (10 of 10).
 *   - «N/CUOTAS PRECIO CONTADO» / «TRES CUOTAS … CONTADO»: cuota 1 bills at the purchase cycle's
 *     own close (9 of 9).
 * BCI Lider bills «cuota comercio» in the purchase cycle (4 of 4); each issuer's timing is data
 * (`CC_ISSUERS[…].first_cuota`). BCI has no feed, so the feed rules only ever see Santander rows.
 *
 * Reading the type and the count out of the feed is ingest's job
 * (`ingest/src/santander/cuotaPurchases.ts`); a listing names the timing canonically
 * (`first_cuota_bills`), mapped back to these kinds by `cardListingLines.ts`.
 */

import { ccIssuerBySlug, type CcIssuerSlug } from "./ccIssuers.js";

export type CcCuotaPurchaseKind = "cuota_comercio" | "precio_contado";

/**
 * Billing month of cuota 1 for a purchase of `kind` made in `purchaseCycleMonth` (YYYY-MM) on a
 * card of `issuer`: the issuer's timing for the kind (`CC_ISSUERS[…].first_cuota`).
 */
export function firstCuotaBillingMonth(
  issuer: CcIssuerSlug,
  kind: CcCuotaPurchaseKind,
  purchaseCycleMonth: string
): string {
  if (ccIssuerBySlug(issuer)!.first_cuota[kind] === "purchase_cycle") return purchaseCycleMonth;
  const [y, m] = purchaseCycleMonth.split("-").map(Number) as [number, number];
  const next = m === 12 ? { y: y + 1, m: 1 } : { y, m: m + 1 };
  return `${next.y}-${String(next.m).padStart(2, "0")}`;
}
