import { z } from "zod";
import { defineIngestKind } from "../defineKind.js";

const text = z.string().trim().min(1);

/** One separate card charge of a payment that was not taken in one (in cuotas or not). */
export const receiptChargeSchema = z
  .object({
    amount: z.number().positive(),
    /** The cuotas this charge was split into (null = one charge). */
    installments: z.number().int().min(2).nullable(),
  })
  .strict();

export type ReceiptCharge = z.infer<typeof receiptChargeSchema>;

export const processorReceiptSchema = z
  .object({
    /** The mail's Message-ID: the receipt's identity. */
    message_id: text,
    /** When the processor sent it, on the Chile clock: `YYYY-MM-DD HH:MM`. */
    sent_at_chile: z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/),
    /** Who mailed it: a payment processor (`flow`, `pago_facil`) or a shop platform's order confirmation (`shopify`). */
    processor: z.string().regex(/^[a-z][a-z0-9_]*$/),
    /** Who was paid, as the receipt names them. */
    payee: z
      .object({
        name: text,
        rut: text.nullable(),
        email: text.nullable(),
      })
      .strict(),
    /**
     * As printed; pesos are whole, dollars to the cent. Null when the document states no amount
     * (MercadoLibre's purchase mails since 2026): it then pairs by its day and the charge's name.
     */
    amount: z.number().positive().nullable(),
    currency: z.enum(["clp", "usd"]),
    /** When the payment went through, on the Chile clock: `YYYY-MM-DD HH:MM`. */
    paid_at_chile: z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/),
    order_ref: text.nullable(),
    /** What the payment was for, as the merchant described it. */
    concept: text.nullable(),
    /** How the receipt says the charge reads on the statement («PAGOS.FLOW.CL (WEB)»). */
    statement_descriptor: text.nullable(),
    payment_method: text.nullable(),
    /** Installments the payment was split into (null = a single charge). */
    installments: z.number().int().min(2).nullable(),
    /**
     * The separate card charges the payment was taken as, when the document says it was more than
     * one (a MercadoLibre order from two sellers: «1x $ 8.865 y 1x $ 6.860»); they add up to
     * `amount`. Null = one charge of `amount`.
     */
    charges: z.array(receiptChargeSchema).min(2).nullable(),
  })
  .strict()
  .refine((r) => r.amount == null || r.currency !== "clp" || Number.isInteger(r.amount), { message: "pesos must be whole" })
  .refine((r) => r.amount == null || r.currency !== "usd" || Math.abs(r.amount * 100 - Math.round(r.amount * 100)) < 1e-6, {
    message: "dollars are to the cent",
  })
  .refine((r) => r.charges == null || (r.amount != null && Math.abs(r.charges.reduce((s, c) => s + c.amount, 0) - r.amount) < 0.005), {
    message: "the charges add up to the amount",
  })
  .refine((r) => r.charges == null || r.installments == null, { message: "a split payment states its cuotas per charge" });

export type ProcessorReceipt = z.infer<typeof processorReceiptSchema>;

/**
 * Receipts payment processors mailed the client, and shops' order confirmations: who each card or
 * bank charge actually paid, for what. The server stores them; pairing with the charges is derived
 * when the expense lines are built.
 */
export const paymentProcessorReceiptsKind = defineIngestKind({
  kind: "payment.processor_receipts",
  // v2 (2026-10-07): a receipt may be in dollars (`currency: "usd"`).
  // v3 (2026-10-07): a receipt states the separate charges a payment was taken as (`charges`), and
  // may state no amount (`amount: null`).
  schema_version: 3,
  description: "Payment processors' receipts and shops' order confirmations: who each charge paid, for what.",
  payload: z
    .object({ receipts: z.array(processorReceiptSchema) })
    .strict()
    .superRefine((p, ctx) => {
      const seen = new Set<string>();
      for (const r of p.receipts) {
        if (seen.has(r.message_id)) ctx.addIssue({ code: "custom", message: `receipt ${r.message_id} listed twice` });
        seen.add(r.message_id);
      }
    }),
});

export type PaymentProcessorReceiptsPayload = z.infer<typeof paymentProcessorReceiptsKind.payload>;

/** `details` of an applied `payment.processor_receipts` result. */
export type PaymentProcessorReceiptsApplyDetails = {
  received: number;
  new_receipts: number;
  /** Stored receipts paired with their expense line (a split payment: with all of its lines), as the expenses page will show them. */
  paired: number;
  /** Receipts left unpaired, by reason. */
  unpaired: Record<string, number>;
  ambiguous: string[];
};
