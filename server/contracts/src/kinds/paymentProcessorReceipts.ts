import { z } from "zod";
import { PAYMENT_PROCESSOR_SLUGS } from "../dto/paymentProcessors.js";
import { chileMinuteSchema, hasAtMostCents, isoDateSchema, currencyCodeSchema } from "../formats/index.js";
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


/** A ride the receipt is for: where it started and ended, as the receipt prints them. */
export const receiptTripSchema = z
  .object({
    from: text,
    to: text,
    /** Chile clock, `YYYY-MM-DD HH:MM`, when printed. */
    started_at_chile: chileMinuteSchema.nullable(),
    ended_at_chile: chileMinuteSchema.nullable(),
    distance_km: z.number().nonnegative().nullable(),
  })
  .strict();

export type ReceiptTrip = z.infer<typeof receiptTripSchema>;


/** A stay the receipt is for (Booking, Airbnb, a hotel's own mail): when, and where. */
export const receiptStaySchema = z
  .object({
    check_in: isoDateSchema,
    check_out: isoDateSchema,
    city: text.nullable(),
  })
  .strict()
  .refine((s) => s.check_out >= s.check_in, { message: "check-out is not before check-in" });

export type ReceiptStay = z.infer<typeof receiptStaySchema>;

/** The event a ticket receipt is for (PuntoTicket, Toliv, Ticketmaster, Paylogic…): what, when, where. */
export const receiptEventSchema = z
  .object({
    name: text,
    starts_on: isoDateSchema,
    /** `HH:MM` on the event's own clock, when printed. */
    starts_at: z.string().regex(/^\d{2}:\d{2}$/).nullable(),
    /** The last day of an event of several days (a festival); null for one of one day. */
    ends_on: isoDateSchema.nullable(),
    /** The venue or its address, as printed. */
    venue: text.nullable(),
  })
  .strict()
  .refine((e) => e.ends_on == null || e.ends_on >= e.starts_on, { message: "the event ends before it starts" });

export type ReceiptEvent = z.infer<typeof receiptEventSchema>;

/**
 * The vehicle permit (permiso de circulación) a municipality's receipt is for: the year, the plate,
 * which cuota of how many this payment is, and the day the permit it issues expires.
 */
export const receiptVehiclePermitSchema = z
  .object({
    permit_year: z.number().int().min(2000).max(2100),
    plate: text,
    cuota: z.number().int().min(1).max(2),
    /** 1 = this payment is the whole year. */
    cuotas: z.number().int().min(1).max(2),
    expires_on: isoDateSchema,
  })
  .strict()
  .refine((p) => p.cuota <= p.cuotas, { message: "the cuota is not past the cuotas" });

export type ReceiptVehiclePermit = z.infer<typeof receiptVehiclePermitSchema>;

export const processorReceiptSchema = z
  .object({
    /** The mail's Message-ID: the receipt's identity. */
    message_id: text,
    /** When the processor sent it, on the Chile clock: `YYYY-MM-DD HH:MM`. */
    sent_at_chile: chileMinuteSchema,
    /** Who mailed it: a payment processor (`flow`, `pago_facil`) or a shop platform's order confirmation (`shopify`). */
    processor: z.enum(PAYMENT_PROCESSOR_SLUGS),
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
    /**
     * ISO 4217, lowercase: «clp», «usd», or the local currency a receipt abroad prints («eur»,
     * «nzd», «brl»); the card's dollar statement prints such a charge's original amount beside it.
     */
    currency: currencyCodeSchema,
    /** When the payment went through, on the Chile clock: `YYYY-MM-DD HH:MM`. */
    paid_at_chile: chileMinuteSchema,
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
    /** The ride, for a receipt of one (Uber). */
    trip: receiptTripSchema.nullable().optional(),
    /**
     * The stay, for a lodging receipt. A stay the property charges (no `statement_descriptor` of the
     * platform's own) may land at booking or at check-in, so it pairs within the stay's window.
     */
    stay: receiptStaySchema.nullable().optional(),
    /** The event, for a ticket receipt. */
    event: receiptEventSchema.nullable().optional(),
    /** The vehicle permit, for a municipality's permiso de circulación. */
    vehicle_permit: receiptVehiclePermitSchema.nullable().optional(),
    /** The document states the payment is a subscription's (Uber One's monthly charge). */
    subscription: z.boolean().optional(),
  })
  .strict()
  .refine((r) => r.amount == null || r.currency !== "clp" || Number.isInteger(r.amount), { message: "pesos must be whole" })
  .refine((r) => r.amount == null || r.currency === "clp" || hasAtMostCents(r.amount), {
    message: "amounts other than pesos are to the cent",
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
  ref: "read",
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
