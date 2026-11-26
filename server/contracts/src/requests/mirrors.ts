/** Request bodies of the mirror-pair routes (`server/src/routes/movementMirrors.ts`). */
import { z } from "zod";
import { rowIdSchema } from "./fields.js";

const PAIRS_MESSAGE = "pairs must be a non-empty array of {out_movement_id, in_movement_id}";

/** `POST /api/movement-mirrors/{convert,reject,unreject}`: the pairs, each an outflow and an inflow movement. */
export const mirrorPairsRequestSchema = z.object({
  pairs: z
    .array(z.object({ out_movement_id: rowIdSchema, in_movement_id: rowIdSchema }), { error: PAIRS_MESSAGE })
    .min(1, PAIRS_MESSAGE),
});
export type MirrorPairsRequest = z.input<typeof mirrorPairsRequestSchema>;

/** `POST /api/movement-mirrors/convert-cc-payments`: each checking debit and the card evidence it pays. */
export const ccPaymentMirrorsRequestSchema = z.object({
  pairs: z
    .array(
      z.object({
        out_movement_id: rowIdSchema,
        statement_line_id: z.number().nullish(),
        statement_id: z.number().nullish(),
      }),
      { error: "pairs must be a non-empty array" }
    )
    .min(1, "pairs must be a non-empty array"),
});
export type CcPaymentMirrorsRequest = z.input<typeof ccPaymentMirrorsRequestSchema>;
