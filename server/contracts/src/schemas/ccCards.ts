import { z } from "zod";

const last4s = z.array(z.string()).default([]);

/**
 * `cfraser/cc-cards.json`: personal per-card configuration (real card last4s), kept OUTSIDE git and
 * read by the server (`server/src/ccCardRegistry.ts`) and by the PDF parser (`ingest/python/
 * cc_cards.py`). Every key is optional (a missing key is empty) and an unknown key is an error. The
 * keys each side reads are named in their descriptions; both validate the whole file against this
 * schema (`data/schemas/cc-cards.schema.json`).
 */
export const ccCardRegistrySchema = z.strictObject({
  import_redirect_last4: z
    .record(z.string(), z.string())
    .default({})
    .describe("Predecessor/consolidated card last4 → successor master last4 (import routing). Server and parser."),
  superseded_master_notes: z
    .array(z.string())
    .default([])
    .describe("`accounts.import_key` of superseded card masters kept out of group totals. Server."),
  multicard_marker_tokens: last4s.describe(
    "Statement-text tokens marking multi-card Santander layouts (`XXXX-<last4>`). Server and parser."
  ),
  legacy_group_b_tokens: last4s.describe('Filename tokens for the legacy "group B" Santander parser body. Parser.'),
  lider_filename_last4s: last4s.describe("Card last4s in BCI Lider statement filenames. Server and parser."),
  reconcile_skip_last4s: last4s.describe("Cards whose statements skip the parse reconcile (superseded). Parser."),
  reconcile_primary_last4s: last4s.describe("Primary cards whose statements require the parse reconcile. Parser."),
  additional_card_last4s: last4s.describe(
    "Additional-cardholder plastics: only these origins auto-tag a purchase Único + no_cuenta (the user's own predecessor/successor plastics must not). Server."
  ),
  boleta_sucursal_merchants: z
    .record(z.string(), z.string())
    .default({})
    .describe(
      "Boleta «SUC:» header → the bank's merchant string for that store (statement convention, no `(T)`); a hand-declared seed beside the learned `grocery_branch_merchants`. Server."
    ),
});

export type CcCardRegistry = z.infer<typeof ccCardRegistrySchema>;
