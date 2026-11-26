/** Request bodies of the movement write routes (`server/src/routes/movements.ts`). */
import { z } from "zod";
import { rowIdSchema } from "./fields.js";

/**
 * `POST /api/accounts/:id/movements`: a JSON object whose fields the account decides — a
 * transfer, a trade, a cash or a peso movement each read their own (`validateMovementCreate`,
 * driven by the account's `movement_create` capability, which the client renders as its form).
 */
export const movementCreateBodySchema = z.record(z.string(), z.unknown());
export type MovementCreateBody = z.input<typeof movementCreateBodySchema>;

/** `POST /api/accounts/:id/option-assignments` (the contract, the shares and the cash checked by the server). */
export const optionAssignmentSchema = z.object({
  stock_account_id: rowIdSchema,
  cash_account_id: rowIdSchema,
  occurred_on: z.string().trim(),
  contracts: z.number(),
  note: z.string().nullish(),
});
export type OptionAssignmentRequest = z.input<typeof optionAssignmentSchema>;

/** `POST /api/accounts/:id/valuations`: a peso mark on a day (dates compare lexically downstream). */
export const valuationUpsertSchema = z.object({
  as_of_date: z
    .string({ error: "as_of_date must be YYYY-MM-DD" })
    .regex(/^\d{4}-\d{2}-\d{2}$/, "as_of_date must be YYYY-MM-DD"),
  value_clp: z.number({ error: "value_clp must be a finite number" }),
});
export type ValuationUpsert = z.input<typeof valuationUpsertSchema>;
