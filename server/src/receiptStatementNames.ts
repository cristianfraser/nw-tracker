/**
 * How a marketplace's own statement names read on a card (leaf: the receipt matcher and the display
 * names share it).
 *
 * MercadoPago's statement prefix, whole or cut by the listing («MP *MERCADOPAGO NT», «MP *MERCADOPAGO»,
 * «MP *MERCADO»): the one name a marketplace order and a MercadoPago payment in a shop share. An
 * amountless receipt takes such a charge only when it is the single unclaimed one in its window
 * (`matchPaymentReceipts`) — in-person MercadoPago payments print it too, so two candidates link
 * nothing. A bare «MERPAGO*» never qualifies.
 */
export const MERCADOPAGO_PREFIX_CHARGE: Record<string, RegExp> = {
  mercadolibre: /^MP\s*\*\s*MERCADO(?:PAGO|PAG|PA|P)?(?:\s|$)/i,
};

/**
 * The statement name of the store a receipt proves, for a charge that carries only the processor's
 * prefix: the receipt names MercadoLibre, so the line reads as MercadoLibre does in the vendor
 * catalog (the seller stays the link label, never the merchant).
 */
export const STORE_STATEMENT_NAME_FOR_PREFIX_CHARGE: Record<string, string> = {
  mercadolibre: "MP *MERCADO LIBRE",
};
