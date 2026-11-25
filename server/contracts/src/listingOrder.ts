import { z } from "zod";

/**
 * The order a listing prints its rows in. Every bank listing read so far prints its newest row
 * first (Santander's card feed and checking «últimos movimientos», Lider BCI's «por facturar», the
 * pasted web tables), so that is the default; a feeder whose source prints oldest first says so on
 * its payload. Rows of one day carry no time, so this order is the only within-day order the
 * ledger can keep: the server writes a listing's new rows oldest first (`flow_first_seen`).
 */
export const LISTING_ORDERS = ["newest_first", "oldest_first"] as const;
export const listingOrderSchema = z.enum(LISTING_ORDERS);
export type ListingOrder = z.infer<typeof listingOrderSchema>;
export const DEFAULT_LISTING_ORDER: ListingOrder = "newest_first";

/** The rows of a listing, oldest first. */
export function listedOldestFirst<T>(rowsAsListed: readonly T[], order: ListingOrder = DEFAULT_LISTING_ORDER): T[] {
  return order === "newest_first" ? [...rowsAsListed].reverse() : [...rowsAsListed];
}
