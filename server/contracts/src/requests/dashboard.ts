/** Request bodies of the dashboard and tax-residency write routes (`server/src/routes/dashboard.ts`, `taxResidency.ts`). */
import { z } from "zod";

/**
 * `POST /api/upcoming-payments/recurring`: a JSON object; its fields (name, frequency, due day and
 * month, amount in pesos or UF, merchant patterns, match window, tolerance) are checked together
 * by the server's `createRecurringPayment`, which answers each rule by name.
 */
export const recurringPaymentCreateSchema = z.record(z.string(), z.unknown());
export type RecurringPaymentCreate = z.input<typeof recurringPaymentCreateSchema>;

/** `POST /api/tax-residency`: a jurisdiction from a day (the jurisdiction list and the day order are the server's). */
export const taxResidencyDeclareSchema = z.object({
  jurisdiction: z.string(),
  from: z.string(),
  note: z.string().nullish(),
});
export type TaxResidencyDeclare = z.input<typeof taxResidencyDeclareSchema>;
