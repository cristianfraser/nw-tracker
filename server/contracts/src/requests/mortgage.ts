/** Request bodies of the mortgage payment routes (`server/src/routes/mortgage.ts`). */
import { z } from "zod";
import { requiredText } from "./fields.js";

const required = (key: string) => z.number({ error: `${key} is required` });
const optional = (key: string) => z.number({ error: `${key} must be a number when provided` }).nullish();

/**
 * `POST /api/accounts/:id/mortgage-payments[/preview]`: the form's figures under role-named keys
 * (`_pay` in the payment currency, `_loan` in the loan currency); `MortgagePaymentInputDto`'s shape.
 */
export const mortgagePaymentBodySchema = z.object({
  occurred_on: requiredText("occurred_on is required"),
  pago_pay: required("pago_pay"),
  interes_pay: required("interes_pay"),
  incendio_pay: required("incendio_pay"),
  desgravamen_pay: optional("desgravamen_pay"),
  cuota: z.string().trim().nullish(),
  /** The lender's minimum and maximum payment, as its statement prints them. */
  min_loan: optional("min_loan"),
  max_loan: optional("max_loan"),
  amortizacion_ext_pay: optional("amortizacion_ext_pay"),
  /** The balance after the payment as the lender states it. */
  credito_restante_loan: optional("credito_restante_loan"),
});
export type MortgagePaymentBody = z.input<typeof mortgagePaymentBodySchema>;
