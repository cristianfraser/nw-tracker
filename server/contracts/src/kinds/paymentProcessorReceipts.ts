import { z } from "zod";
import { defineIngestKind } from "../defineKind.js";

const text = z.string().trim().min(1);

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
    /** As printed; pesos are whole. */
    amount: z.number().positive(),
    currency: z.enum(["clp"]),
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
  })
  .strict()
  .refine((r) => r.currency !== "clp" || Number.isInteger(r.amount), { message: "pesos must be whole" });

export type ProcessorReceipt = z.infer<typeof processorReceiptSchema>;

/**
 * Receipts payment processors mailed the client, and shops' order confirmations: who each card or
 * bank charge actually paid, for what. The server stores them; pairing with the charges is derived
 * when the expense lines are built.
 */
export const paymentProcessorReceiptsKind = defineIngestKind({
  kind: "payment.processor_receipts",
  schema_version: 1,
  description: "Payment processors' receipts: who each charge paid, for what.",
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
  /** Stored receipts that pair with exactly one expense line, as the expenses page will show them. */
  paired: number;
  /** Receipts left unpaired, by reason. */
  unpaired: Record<string, number>;
  ambiguous: string[];
};
