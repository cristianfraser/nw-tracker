import { z } from "zod";
import { defineIngestKind } from "../defineKind.js";

const text = z.string().trim().min(1);

/**
 * The lender's receipt for one mortgage cuota (dividendo) paid online — MetLife Hipotecario's
 * «Pago de dividendo realizado» mail: what was paid, when, the lender's transaction id, the credit,
 * the dividend paid and its due date. The source ref is the mail's message id.
 *
 * The mail does not say which card paid. `card_last4` is the feeder's declaration
 * (`cfraser/metlife-fetch.json` `paid_with_card_last4`): the card the cuota is charged to, on
 * which the server plants the charge until the card's statement prints it.
 */
export const mortgagePaymentReceiptKind = defineIngestKind({
  kind: "mortgage.payment_receipt",
  schema_version: 1,
  description: "A mortgage lender's receipt for one cuota paid online.",
  ref: "document",
  payload: z
    .object({
      /** Lender slug («metlife»). */
      lender: z.string().regex(/^[a-z][a-z0-9_]*$/),
      /** The lender's transaction id, as printed: with the lender, the receipt's identity. */
      transaction_id: text,
      paid_on: z.iso.date(),
      /** «Monto total pagado», pesos. */
      amount_clp: z.number().int().positive(),
      /** The credit (loan) number, as printed. */
      credit_number: text,
      /** The dividend paid (N° de dividendo), as printed. */
      dividend_number: text,
      /** The dividend's due date («Fecha de vencimiento»). */
      due_on: z.iso.date(),
      card_last4: z.string().regex(/^\d{4}$/),
    })
    .strict(),
});

export type MortgagePaymentReceiptPayload = z.infer<typeof mortgagePaymentReceiptKind.payload>;

/** `details` of an applied `mortgage.payment_receipt`. */
export type MortgagePaymentReceiptApplyDetails = {
  receipt_id: number;
  card_account_id: number;
  /**
   * `planted`: the charge was added to the card's open cycle; `on_file`: the card already lists it
   * (its statement, a paste, a re-send).
   */
  card_line: "planted" | "on_file";
  detail: string;
};
