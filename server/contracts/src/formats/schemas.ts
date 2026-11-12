/** Zod building blocks the ingest contracts share. */
import { z } from "zod";
import { hasAtMostCents } from "./numbers.js";

/** A real calendar day, `YYYY-MM-DD`. */
export const isoDateSchema = z.iso.date();

/** A Chile wall-clock minute, `YYYY-MM-DD HH:MM`. */
export const chileMinuteSchema = z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);

/** A Chile wall-clock second, `YYYY-MM-DD HH:MM:SS`. */
export const chileSecondSchema = z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

/** An amount with at most two decimals. */
export const centsSchema = z.number().refine(hasAtMostCents, { message: "amount must be in cents" });

/**
 * A currency as a lowercase ISO 4217 code (`clp`, `usd`, `eur`). The contract checks the shape
 * only: which codes the app knows is the server's `currencies` table, checked on receipt.
 */
export const currencyCodeSchema = z.string().regex(/^[a-z]{3}$/, { message: "currency must be a lowercase ISO 4217 code" });

/** A lowercase ISO 4217 code (see {@link currencyCodeSchema}). */
export type CurrencyCode = string;

/** Whole pesos carry no decimals, any other currency at most cents. */
export function amountFitsCurrency(amount: number, currency: CurrencyCode): boolean {
  return currency === "clp" ? Number.isInteger(amount) : hasAtMostCents(amount); // convention-ok: pesos have no minor unit; every other code a document states carries cents
}

/** A dividend's gross less its withholding is its net, to a cent and a half of rounding. */
export function grossLessWithholdingIsNet(d: { gross: number; withholding: number; net: number }): boolean {
  return Math.abs(d.gross - d.withholding - d.net) <= 0.015;
}

/** A calendar month, `YYYY-MM`. */
export const yearMonthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
