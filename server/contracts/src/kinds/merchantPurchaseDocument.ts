import { z } from "zod";
import { defineIngestKind } from "../defineKind.js";

/**
 * A merchant's own record of what a card charge bought: a receipt listing the items paid for,
 * or a notice about a subscription (confirmed, about to renew, expiring, changing price). Card
 * statements name only the merchant («APPLE.COM/BILL»); these documents name the app or service,
 * which the server writes onto the charge's expense note. The source ref is the source's own
 * identity (the mail's message id): a resend never stores it twice.
 */

/** A merchant slug: which store issued the document, e.g. `apple_app_store`. */
const merchantSchema = z.string().regex(/^[a-z][a-z0-9_]*$/);

const currencySchema = z.enum(["clp", "usd"]);

/** Pesos are whole; dollars carry cents. */
const moneySchema = z
  .object({ amount: z.number().positive(), currency: currencySchema })
  .strict()
  .refine((m) => m.currency !== "clp" || Number.isInteger(m.amount), { message: "pesos are whole" });

/** How often a subscription bills, as the document prints it. */
export const subscriptionPeriodSchema = z.enum(["day", "week", "month", "quarter", "half_year", "year"]);
export type SubscriptionPeriod = z.infer<typeof subscriptionPeriodSchema>;

const last4Schema = z.string().regex(/^\d{4}$/);

export const merchantReceiptItemSchema = z
  .object({
    /**
     * The app or service the item belongs to, as printed; null when the receipt names only the
     * product («1 Boost»), which the server then resolves from other documents or reports.
     */
    app: z.string().min(1).max(200).nullable(),
    /** The product bought (an in-app item, a plan); null when the app line is all there is. */
    product: z.string().min(1).max(200).nullable(),
    amount: z.number().positive(),
    /** True for a subscription (the item renews); false for a one-off purchase. */
    renews: z.boolean(),
    period: subscriptionPeriodSchema.nullable(),
    /** The item's artwork as the document links it: the same app shows the same picture. */
    icon_url: z.string().url().max(500).nullable(),
  })
  .strict();

export type MerchantReceiptItem = z.infer<typeof merchantReceiptItemSchema>;

const receiptSchema = z
  .object({
    type: z.literal("receipt"),
    issued_on: z.iso.date(),
    order_id: z.string().min(1).max(64).nullable(),
    /** The card the receipt says it charged; null when it prints none. */
    card_last4: last4Schema.nullable(),
    total: moneySchema,
    items: z.array(merchantReceiptItemSchema).min(1),
  })
  .strict()
  .refine(
    (r) =>
      Math.abs(r.items.reduce((s, i) => s + i.amount, 0) - r.total.amount) <
      (r.total.currency === "clp" ? 0.5 : 0.005),
    { message: "the items must add up to the total" }
  );

const subscriptionNoticeSchema = z
  .object({
    type: z.literal("subscription_notice"),
    notice: z.enum(["confirmed", "renewal", "expiring", "price_increase"]),
    /** The day the notice was sent. */
    mailed_on: z.iso.date(),
    app: z.string().min(1).max(200),
    plan: z.string().min(1).max(200).nullable(),
    /** What each period costs (for a price increase: the new price). */
    price: moneySchema,
    period: subscriptionPeriodSchema,
    /** The day the subscription was bought (a confirmation prints it). */
    purchased_on: z.iso.date().nullable(),
    /** The next charge the notice announces: a renewal date, or the day a new price starts. */
    next_charge_on: z.iso.date().nullable(),
    /** The day it ends (an expiring notice). */
    expires_on: z.iso.date().nullable(),
    card_last4: last4Schema.nullable(),
  })
  .strict();

export const merchantPurchaseDocumentKind = defineIngestKind({
  kind: "merchant.purchase_document",
  schema_version: 1,
  description: "A merchant's receipt or subscription notice for card charges (what a charge bought).",
  payload: z
    .object({
      merchant: merchantSchema,
      /** What one source carries: a receipt, or the notices one mail lists (usually one). */
      documents: z.array(z.discriminatedUnion("type", [receiptSchema, subscriptionNoticeSchema])).min(1),
    })
    .strict(),
});

export type MerchantPurchaseDocument = MerchantPurchaseDocumentPayload["documents"][number];
export type MerchantPurchaseDocumentPayload = z.infer<typeof merchantPurchaseDocumentKind.payload>;

/** `details` of an applied `merchant.purchase_document`: which charges its receipts name. */
export type MerchantPurchaseDocumentApplyDetails = {
  /** The card charge each receipt of this source paired with; null while it waits for one. */
  receipt_lines: ({ account_id: number; date: string } | null)[];
  /** Receipts whose app could not be named (the item names only a product). */
  unresolved: { issued_on: string; products: string[] }[];
};
