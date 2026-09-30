import { z } from "zod";
import { defineIngestKind } from "../defineKind.js";

/**
 * The bank's receipt for one credit-card payment made from a bank account: when it was paid
 * (the real day — a bank feed dates a payment after its cutoff at the next workday), the pesos
 * that left the account, which debt it paid (the card's peso debt, or its dollar debt bought with
 * those pesos) and the card. The source ref is the receipt's own identity (the mail's message id):
 * a resend of the same receipt never writes a second payment.
 */
export const cardPaymentReceiptKind = defineIngestKind({
  kind: "card.payment_receipt",
  schema_version: 1,
  description: "A bank's receipt for one credit-card payment from a bank account.",
  payload: z
    .object({
      /** Issuer slug of the bank account the pesos left (and of the card). */
      issuer: z.string().regex(/^[a-z][a-z0-9_]*$/),
      paid_on: z.iso.date(),
      debt_currency: z.enum(["clp", "usd"]),
      /** Pesos that left the bank account: the peso payment, or the dollar payment's peso cost. */
      amount_clp: z.number().int().positive(),
      /** Dollars credited to the card's dollar debt; null for a peso payment (or a receipt that prints none). */
      amount_usd: z.number().positive().nullable(),
      card_last4: z.string().regex(/^\d{4}$/).nullable(),
    })
    .strict()
    .refine((p) => p.debt_currency === "usd" || p.amount_usd === null, {
      message: "a peso payment carries no dollar amount",
    }),
});

export type CardPaymentReceiptPayload = z.infer<typeof cardPaymentReceiptKind.payload>;

/** `details` of an applied `card.payment_receipt`: what the server did with it. */
export type CardPaymentReceiptApplyDetails = {
  /** `ambiguous`: several same-amount debits could be the payment — nothing written, retried later. */
  status: "redated" | "already_dated" | "synthesized" | "ambiguous";
  movement_id: number | null;
  detail: string;
};
