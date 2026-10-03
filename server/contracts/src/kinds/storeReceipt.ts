import { z } from "zod";
import { defineIngestKind } from "../defineKind.js";

/**
 * A store's receipt for one purchase: what was bought and how it was paid, as the receipt prints
 * it. The feeder reads the document (an e-mailed or saved PDF, or a photo of the paper copy) and
 * sends one receipt per request; the server keeps the receipt and its items, collapses two
 * documents of one purchase onto one receipt, and links the purchase to the card line it was
 * charged as (writing that line for a chain whose card has no other feed).
 */

/** A chain slug: which chain issued the receipt, e.g. `lider`, `jumbo`. */
const chainSchema = z.string().regex(/^[a-z][a-z0-9_-]*$/);

const pesos = z.number().int();

/**
 * The document the receipt was read from. `email`: a receipt the store mailed; `pdf`: a receipt
 * PDF saved by hand (the same document); `photo`: a photo of the paper receipt (read by OCR). An
 * e-mailed or saved PDF outranks a photo when both describe one purchase.
 */
export const STORE_RECEIPT_DOCUMENT_KINDS = ["email", "pdf", "photo"] as const;
export type StoreReceiptDocumentKind = (typeof STORE_RECEIPT_DOCUMENT_KINDS)[number];

export const storeReceiptItemSchema = z
  .object({
    /** Order on the receipt, from 0. */
    position: z.number().int().nonnegative(),
    /** The product code the receipt prints; null when it prints none (or nobody could read it). */
    barcode: z.string().min(1).max(32).nullable(),
    description: z.string().min(1).max(200),
    /** A decimal string: units, or kilos for a weighed item. */
    qty: z.string().regex(/^\d+(\.\d+)?$/),
    qty_unit: z.enum(["un", "kg"]),
    unit_price: pesos,
    /** Before the item's own discounts. */
    total: pesos,
    /** The item's own discounts (printed under it), as a positive amount. */
    discount: pesos.nonnegative(),
    discount_labels: z.array(z.string().min(1).max(200)),
  })
  .strict();

export type StoreReceiptItem = z.infer<typeof storeReceiptItemSchema>;

export const storeReceiptSchema = z
  .object({
    chain: chainSchema,
    /** The receipt's printed number; null when the photo lost it. */
    number: z.string().min(1).max(64).nullable(),
    /** The branch as printed (the address line). */
    branch: z.string().min(1).max(200),
    city: z.string().min(1).max(200).nullable(),
    /** The printed local datetime `YYYY-MM-DD HH:MM:SS`; null when the receipt prints none. */
    purchased_at: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
      .nullable(),
    /** `declared`: written into the OCR correction by hand, because the receipt lost it. */
    purchase_date_source: z.enum(["printed", "declared"]).nullable(),
    items: z.array(storeReceiptItemSchema).min(1),
    /** Whole-receipt rebates (a loyalty-points redemption, a coupon) — never an item's price. */
    receipt_discounts: z.array(z.object({ label: z.string().min(1).max(200), amount: pesos.positive() }).strict()),
    /** Payment legs as the receipt names them (`efectivo`, `tarjeta_lider_bci`, `t_credito`, …). */
    payments: z.array(z.object({ method: z.string().regex(/^[a-z][a-z0-9_]*$/), amount: pesos }).strict()).min(1),
    /** Loyalty points the purchase earned, when printed. */
    loyalty_points: pesos.nonnegative().nullable(),
  })
  .strict()
  .refine((r) => r.purchased_at != null || r.purchase_date_source == null, {
    message: "a purchase date source needs a purchase date",
  });

export type StoreReceipt = z.infer<typeof storeReceiptSchema>;

export const storeReceiptKind = defineIngestKind({
  kind: "store.receipt",
  schema_version: 1,
  description: "A store's receipt for one purchase: items, discounts and payment legs, with the document it was read from.",
  payload: z
    .object({
      /** False: report what the import would do, write nothing. */
      apply: z.boolean(),
      document: z
        .object({
          kind: z.enum(STORE_RECEIPT_DOCUMENT_KINDS),
          /** The document's own identity: the mail's message id, the file's sha256. */
          key: z.string().min(1).max(512),
          /** The day a photo was taken, when the file's name says it; bounds an undated receipt's date. */
          photo_taken_on: z.iso.date().nullable(),
        })
        .strict()
        .refine((d) => d.kind === "photo" || d.photo_taken_on == null, { message: "only a photo has a photo date" }),
      receipt: storeReceiptSchema,
    })
    .strict(),
});

export type StoreReceiptPayload = z.infer<typeof storeReceiptKind.payload>;

/** `details` of an applied `store.receipt` (the feeder prints it and stamps a final outcome). */
export type StoreReceiptApplyDetails = {
  chain: string;
  receipt_key: string;
  /** −1 in a dry run for a receipt that would be inserted. */
  receipt_id: number;
  /**
   * `inserted` / `updated` (this document owns the receipt), `replaced` (it took the receipt over
   * from a lower-ranked document), `skipped_duplicate` (another document owns it; nothing written).
   */
  receipt_status: "inserted" | "updated" | "replaced" | "skipped_duplicate";
  /** replaced: the document kind it displaced; skipped_duplicate: the kind that owns the receipt. */
  other_document: StoreReceiptDocumentKind | null;
  purchased_at: string;
  purchase_date_source: "printed" | "declared" | "card_line" | "photo";
  card_paid: number;
  items: number;
  items_classified: number;
  movement:
    | { status: "created" | "duplicate" | "same_day_amount" }
    | { status: "closed_month" | "not_card_paid" | "chain_items_only" | "not_attempted" }
    | { status: "awaiting_card_line" | "no_card_line" }
    | { status: "ambiguous_card_line"; candidates: number }
    | { status: "pending_branch"; branch: string }
    | { status: "matched"; branch: string; merchant: string | null };
  /** False while the outcome can still change (a receipt waiting for its card line): send it again. */
  final: boolean;
};
