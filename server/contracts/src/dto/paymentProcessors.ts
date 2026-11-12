/**
 * Who issued a payment document (docs/untangle-plan.md F8): a payment processor (`flow`,
 * `pago_facil`), a shop or platform's order mail (`shopify`, `amazon`, …), or — never sent by a
 * feeder, set by the server when an App Store receipt explains a charge — `apple_app_store`, the
 * slug `merchant.purchase_document` stores for Apple. The `payment.processor_receipts` kind accepts
 * these, the server's per-processor tables are keyed by them, and an expense line's
 * `payment_receipt.processor` is one of them.
 */
export const PAYMENT_PROCESSOR_SLUGS = [
  "accor",
  "adidas",
  "airbnb",
  "aitickets",
  "amazon",
  "amazon_order",
  "apple_app_store",
  "booking",
  "calvin_klein",
  "club_domino",
  "despegar",
  "dynavap",
  "eventbrite",
  "flow",
  "latam",
  "latam_change",
  "mercadolibre",
  "micoca_cola",
  "municipalidad_maipu",
  "namecheap",
  "pago_facil",
  "paylogic",
  "puntoticket",
  "shopify",
  "stripe",
  "ticketmaster_cl",
  "ticketmaster_nz",
  "ticketplus",
  "toliv",
  "uber",
  "uber_eats",
  "uber_eats_summary",
  "uber_one",
  "uber_trip_summary",
] as const;

export type PaymentProcessorSlug = (typeof PAYMENT_PROCESSOR_SLUGS)[number];

/** A stored slug as the type; an unknown one is an error (the kind accepts only these). */
export function paymentProcessorSlug(raw: string): PaymentProcessorSlug {
  if (!(PAYMENT_PROCESSOR_SLUGS as readonly string[]).includes(raw)) {
    throw new Error(`unknown payment processor slug: ${raw}`);
  }
  return raw as PaymentProcessorSlug;
}
