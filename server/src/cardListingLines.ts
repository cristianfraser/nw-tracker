import type { CardListingLine } from "nw-tracker-contracts";
import type { CcCuotaPurchaseKind } from "./ccCuotaPurchaseKinds.js";
import { webPasteAmountFromDebtPositive } from "./ccPaymentLines.js";
import type { CcWebPasteLine } from "./ccWebPasteParse.js";

const CUOTA_KIND_BY_FIRST_BILLING: Readonly<
  Record<NonNullable<CardListingLine["cuota_purchase"]>["first_cuota_bills"], CcCuotaPurchaseKind>
> = {
  next_cycle: "cuota_comercio",
  purchase_cycle: "precio_contado",
};

/**
 * An ingested card-listing line (`card.unbilled_movements`, debt-positive) → the web-paste line
 * the card import path takes, amount in the issuer's web-UI sign so the import stores it exactly
 * as a paste of the same row.
 */
export function webPasteLineFromCardListingLine(cardGroup: string, line: CardListingLine): CcWebPasteLine {
  const pasted = webPasteAmountFromDebtPositive(line.amount, cardGroup);
  const cp = line.cuota_purchase;
  return {
    transaction_date: line.date,
    merchant: line.merchant,
    amount_clp: line.currency === "usd" ? 0 : pasted,
    amount_usd: line.currency === "usd" ? pasted : null,
    currency: line.currency,
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
