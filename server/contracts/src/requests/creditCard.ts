/** Request bodies of the card write routes (`server/src/routes/creditCard.ts`). */
import { z } from "zod";

/** `PATCH /api/accounts/:id/cc-purchases/:purchaseId`: a manual plan's fields (null = unchanged). */
export const ccPurchasePatchSchema = z.object({
  purchase_date: z.string().nullish(),
  /** A manual plan is entered in the card's billing pesos. */
  total_amount_clp: z.number().nullish(),
  cuotas_totales: z.number().nullish(),
  merchant: z.string().nullish(),
  description: z.string().nullish(),
});
export type CcPurchasePatch = z.input<typeof ccPurchasePatchSchema>;

/** `POST /api/accounts/:id/annulled-purchases`: the purchase line the bank voided, and the day (checked by the server). */
export const annulledPurchaseCreateSchema = z.object({
  line_id: z.number({ error: "invalid statement line id" }).int("invalid statement line id").positive("invalid statement line id"),
  annulled_on: z.string(),
});
export type AnnulledPurchaseCreate = z.input<typeof annulledPurchaseCreateSchema>;

const CUOTAS_POSITIVE = "cuotas_totales must be a positive number";
/** `POST …/cc-statement-lines/:lineId/make-installment`. */
export const makeInstallmentSchema = z.object({
  cuotas_totales: z.number({ error: CUOTAS_POSITIVE }).positive(CUOTAS_POSITIVE),
});
export type MakeInstallment = z.input<typeof makeInstallmentSchema>;

/** `POST …/imports/cc-web-paste`, `…/imports/cuenta-vista-web-paste`: the text as pasted. */
export const webPasteSchema = z.object({
  text: z.string({ error: "text is required" }).refine((t) => t.trim() !== "", { message: "text is required" }),
});
export type WebPaste = z.input<typeof webPasteSchema>;
