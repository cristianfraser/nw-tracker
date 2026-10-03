import { z } from "zod";

/**
 * A card's movements pasted by hand from the issuer's web table (`POST /parse/card.web_paste`).
 * Not an ingest kind: a paste names no account — the server applies it to the card the user
 * pasted into, through the issuer's own sign rules — so it only ever arrives as a parse result.
 * Amounts are kept as the table prints them (signed as printed: Santander lists charges
 * negative, BCI positive), merchants as printed.
 */
export const CARD_PASTED_LISTING = { kind: "card.pasted_listing", schema_version: 1 } as const;

export const pastedListingLineSchema = z
  .object({
    /** The row's date, or the last date above it (the table prints a date once per day). */
    date: z.iso.date(),
    merchant: z.string().min(1).max(200),
    /** Signed as printed; pesos are whole, dollars carry cents. */
    amount: z.number().refine((n) => n !== 0, { message: "a zero amount is not a movement" }),
    currency: z.enum(["clp", "usd"]),
    /** The pasted line, verbatim: provenance. */
    raw_line: z.string().min(1).max(1000),
  })
  .strict()
  .refine((l) => l.currency === "usd" || Number.isInteger(l.amount), { message: "pesos are whole" });

export const cardPastedListingSchema = z
  .object({
    lines: z.array(pastedListingLineSchema),
    /** Lines that could not be read, said in the user's language (shown under the paste box). */
    errors: z.array(z.string()),
  })
  .strict();

export type CardPastedListing = z.infer<typeof cardPastedListingSchema>;
