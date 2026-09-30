import { z } from "zod";
import { defineIngestKind } from "../defineKind.js";

const isoDate = z.iso.date();
const currency = z.enum(["clp", "usd"]);

/** Pesos are whole; dollars carry at most cents. */
function amountFitsCurrency(amount: number, cur: "clp" | "usd"): boolean {
  if (!Number.isFinite(amount)) return false;
  if (cur === "clp") return Number.isInteger(amount);
  return Math.abs(Math.round(amount * 100) - amount * 100) < 1e-6;
}

/** A card account as the issuer numbers it; the server maps it to its own card account. */
export const issuerCardAccountSchema = z
  .object({
    /** Issuer slug, e.g. `santander`. */
    issuer: z.string().regex(/^[a-z][a-z0-9_]*$/),
    /** The issuer's account (contract) number, digits only. */
    number: z.string().regex(/^\d+$/),
  })
  .strict();

/**
 * A purchase made in cuotas that the listing shows at its full principal. When cuota 1 bills
 * decides which facturación carries it; the count is often not listed yet (the statement will
 * print it), and is then null.
 */
export const cuotaPurchaseSchema = z
  .object({
    /** `purchase_cycle`: cuota 1 bills at the close of the cycle the purchase falls in; `next_cycle`: one close later. */
    first_cuota_bills: z.enum(["purchase_cycle", "next_cycle"]),
    cuota_count: z.number().int().positive().nullable(),
    /** Where the count came from: printed in the listing, or derived from the purchase's stamp tax. */
    count_source: z.enum(["printed", "stamp_tax"]).nullable(),
    /** The purchase's stamp tax in pesos, when the listing shows one (even if it gave no count). */
    stamp_tax_clp: z.number().int().positive().nullable(),
  })
  .strict()
  .refine((c) => (c.cuota_count == null) === (c.count_source == null), {
    message: "count_source is set exactly when cuota_count is",
  });

export const cardListingLineSchema = z
  .object({
    date: isoDate,
    merchant: z.string().trim().min(1),
    currency,
    /** Debt-positive: a charge is positive, a payment or credit negative. Never zero. */
    amount: z.number(),
    /** The row exactly as the source rendered it (provenance; never matched on). */
    raw_text: z.string().min(1),
    cuota_purchase: cuotaPurchaseSchema.optional(),
  })
  .strict()
  .superRefine((line, ctx) => {
    if (line.amount === 0 || !amountFitsCurrency(line.amount, line.currency)) {
      ctx.addIssue({
        code: "custom",
        path: ["amount"],
        message: `amount ${line.amount} is not a non-zero ${line.currency} amount`,
      });
    }
    if (line.cuota_purchase && line.currency !== "clp") {
      ctx.addIssue({ code: "custom", path: ["cuota_purchase"], message: "cuota purchases are in pesos" });
    }
  });

export type CardListingLine = z.infer<typeof cardListingLineSchema>;

/**
 * The latest close the issuer states in the listing: its date and the total it billed per
 * currency (debt-positive). A currency with a stated total is listed completely since that
 * close; null means the listing did not state it, and nothing about that currency's lines may be
 * inferred from their absence.
 */
export const observedCloseSchema = z
  .object({
    date: isoDate,
    billed: z
      .object({ clp: z.number().int().nullable(), usd: z.number().nullable() })
      .strict()
      .refine((b) => b.clp != null || b.usd != null, { message: "a close states at least one currency" })
      .refine((b) => b.usd == null || amountFitsCurrency(b.usd, "usd"), { message: "usd has at most cents" }),
  })
  .strict();

export const cardListingSchema = z
  .object({
    account: issuerCardAccountSchema,
    close: observedCloseSchema.nullable(),
    lines: z.array(cardListingLineSchema),
  })
  .strict();

/** The issuer's own statement of a card's credit line, per currency. */
export const issuerCardBalanceSchema = z
  .object({
    account: issuerCardAccountSchema,
    card_last4: z.string().regex(/^\d{4}$/),
    currency,
    limit: z.number().nonnegative(),
    used: z.number().nonnegative(),
    available: z.number().nonnegative(),
  })
  .strict()
  .refine((b) => Math.round(b.limit * 100) === Math.round(b.used * 100) + Math.round(b.available * 100), {
    message: "limit must equal used + available to the cent",
  });

export const issuerCardBalancesSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("observed"),
      observed_at: z.iso.datetime({ offset: true }),
      rows: z.array(issuerCardBalanceSchema),
    })
    .strict(),
  z.object({ status: z.literal("unavailable"), reason: z.string().min(1) }).strict(),
]);

/**
 * What an issuer lists as not yet billed, per card, as of one observation: every movement since
 * the latest close (which the listing may state), plus optionally the issuer's own credit-line
 * balances. Each observation is a whole listing — a movement on file under the open cycle that a
 * complete listing no longer shows is one the issuer dropped.
 */
export const cardUnbilledMovementsKind = defineIngestKind({
  kind: "card.unbilled_movements",
  schema_version: 1,
  description: "A card issuer's unbilled movements since its latest close, with that close and its credit-line balances.",
  payload: z
    .object({
      observed_at: z.iso.datetime({ offset: true }),
      cards: z.array(cardListingSchema),
      /** Absent when the feeder does not read balances. */
      issuer_balances: issuerCardBalancesSchema.optional(),
    })
    .strict()
    .superRefine((p, ctx) => {
      const seen = new Set<string>();
      for (const [i, card] of p.cards.entries()) {
        const key = `${card.account.issuer}|${card.account.number}`;
        if (seen.has(key)) {
          ctx.addIssue({ code: "custom", path: ["cards", i, "account"], message: `card ${key} listed twice` });
        }
        seen.add(key);
      }
    }),
});

export type CardUnbilledMovementsPayload = z.infer<typeof cardUnbilledMovementsKind.payload>;

/** `details` of an applied `card.unbilled_movements` result (informational; not validated). */
export type CardUnbilledMovementsApplyDetails = {
  cards: {
    account: string;
    account_id: number;
    lines: number;
    inserted: number;
    skipped_duplicate: number;
    skipped_cuota_billing: number;
    batch_id: number | null;
    close: {
      date: string;
      billing_month: string;
      status: "new" | "seen";
      billed_clp: number | null;
      billed_usd: number | null;
      rows_billing_month: string;
      lines_moved_forward: number;
      provisional_check: { bank_total_clp: number; app_estimate_clp: number } | null;
    } | null;
    plans_created: {
      purchase_id: number;
      purchase_date: string;
      merchant: string;
      principal_clp: number;
      cuotas: number;
      kind: string;
      first_due_month: string;
    }[];
    first_due_nudges: { purchase_id: number; merchant: string | null; from: string | null; to: string; rule: string }[];
    cuota_lines_tagged: number;
    /** Open-cycle lines the listing no longer shows, removed; null when no currency was mirrored. */
    removed_by_mirror:
      | { id: number; date: string; merchant: string | null; amount_clp: number | null; amount_usd: number | null }[]
      | null;
  }[];
  issuer_balances:
    | { status: "absent" }
    | { status: "missing"; error: string }
    | { status: "recorded" | "seen"; capture_id: number; observed_at: string; snapshots: number };
};
