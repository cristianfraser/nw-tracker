import { z } from "zod";
import { defineIngestKind } from "../defineKind.js";

/**
 * The unemployment fund's stated balance, as its sucursal virtual's home page shows it — read
 * every night. The server compares it with the app's own value of the account that day and keeps
 * the reading; a difference is reported, never acted on (the fund deducts its commission in
 * units between statements, so a small drift is normal; a large one is a new contribution the
 * certificate will show, or a problem to look at).
 */
export const unemploymentFundBalanceKind = defineIngestKind({
  kind: "unemployment_fund.balance",
  schema_version: 1,
  description: "The unemployment fund's (AFC) stated balance and last credited month, from its home page.",
  payload: z
    .object({
      provider: z.enum(["afc"]),
      read_at: z.iso.datetime({ offset: true }),
      /** Null when the page said the balance is not available right now. */
      balance_pesos: z.number().int().nonnegative().nullable(),
      /** The last contribution month the fund has credited (`fechaUltimaCotizacion`'s month). */
      last_contribution_month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).nullable(),
      /** Why the balance is null, in the page's words. */
      unavailable_reason: z.string().max(300).nullable(),
    })
    .strict(),
});

export type UnemploymentFundBalancePayload = z.infer<typeof unemploymentFundBalanceKind.payload>;

/** `details` of an applied `unemployment_fund.balance`. */
export type UnemploymentFundBalanceApplyDetails = {
  account_id: number;
  read_id: number;
  stated_pesos: number | null;
  /** The app's value of the account on the read's Chile day. */
  app_value_clp: number;
  /** stated − app; null without a stated balance. */
  difference_clp: number | null;
  difference_pct: number | null;
  /** The ledger's latest contribution period, for the feeder's log. */
  ledger_last_contribution_month: string | null;
};
