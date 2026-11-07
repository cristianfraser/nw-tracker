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

/** Whole pesos carry no decimals, dollars at most cents. */
export function amountFitsCurrency(amount: number, currency: "clp" | "usd"): boolean {
  return currency === "clp" ? Number.isInteger(amount) : hasAtMostCents(amount);
}

/** A dividend's gross less its withholding is its net, to a cent and a half of rounding. */
export function grossLessWithholdingIsNet(d: { gross: number; withholding: number; net: number }): boolean {
  return Math.abs(d.gross - d.withholding - d.net) <= 0.015;
}

/** A calendar month, `YYYY-MM`. */
export const yearMonthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
