import type { CardListingLine } from "nw-tracker-contracts";
import type { CcCuotaPurchaseKind } from "./ccCuotaPurchaseKinds.js";
import type { CcListingLine } from "./ccWebPasteParse.js";

const CUOTA_KIND_BY_FIRST_BILLING: Readonly<
  Record<NonNullable<CardListingLine["cuota_purchase"]>["first_cuota_bills"], CcCuotaPurchaseKind>
> = {
  next_cycle: "cuota_comercio",
  purchase_cycle: "precio_contado",
};

/**
 * An ingested card-listing line (`card.unbilled_movements`, debt-positive) → the listing line the
 * card import takes: the amount as it is (both are debt-positive), the cuota purchase in the
 * import's vocabulary.
 */
export function listingLineFromCardListingLine(line: CardListingLine): CcListingLine {
  const cp = line.cuota_purchase;
  return {
    transaction_date: line.date,
    merchant: line.merchant,
    currency: line.currency,
    amount: line.amount,
    raw_line: line.raw_text,
    ...(line.holder ? { holder: line.holder } : {}),
    ...(cp
      ? {
          cuota_purchase: {
            kind: CUOTA_KIND_BY_FIRST_BILLING[cp.first_cuota_bills],
            cuota_count: cp.cuota_count,
            count_source:
              cp.count_source === "printed" ? "feed_type" : cp.count_source === "stamp_tax" ? "stamp_tax" : null,
            stamp_tax_clp: cp.stamp_tax_clp,
          },
        }
      : {}),
  };
}
