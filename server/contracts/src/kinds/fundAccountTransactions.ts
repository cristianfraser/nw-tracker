import { z } from "zod";
import { defineIngestKind } from "../defineKind.js";

/**
 * A fund manager's certificate of transactions: every subscription and redemption of each
 * investment (goal), in pesos and in fund units, as the certificate lists them. The server
 * reconciles them against the fund accounts it keeps — a transaction no existing flow covers is
 * added (when applied), nothing already there is changed — and records each listed unit value.
 * Only rows that move money or units are sent; the certificate's daily balance rows are not.
 */

export const fundTransactionSchema = z
  .object({
    date: z.iso.date(),
    /** The investment (goal) as the certificate names it: the manager's id and the given name. */
    investment: z.object({ id: z.string().min(1).max(64), name: z.string().max(200) }).strict(),
    /** The payment channel as printed (`Transferencia electronica`, a bonus, a transfer between funds); null when blank. */
    medio: z.string().min(1).max(200).nullable(),
    clp_in: z.number(),
    clp_out: z.number(),
    units_in: z.number(),
    units_out: z.number(),
    /** The unit value the row prints, pesos per unit; null when absent. */
    unit_value: z.number().positive().nullable(),
  })
  .strict();

export type FundTransaction = z.infer<typeof fundTransactionSchema>;

export const fundAccountTransactionsKind = defineIngestKind({
  kind: "fund_account.transactions",
  schema_version: 1,
  description: "A fund manager's certificate of transactions: subscriptions and redemptions per investment, in pesos and units.",
  payload: z
    .object({
      /** False: report the reconcile, write nothing. */
      apply: z.boolean(),
      provider: z.enum(["fintual"]),
      /** The certificate file: provenance for the report. */
      document: z.string().min(1).max(256),
      /** Ignore transactions after this month (`YYYY-MM`); the server's current month when null. */
      max_month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).nullable(),
      transactions: z.array(fundTransactionSchema),
    })
    .strict(),
});

export type FundAccountTransactionsPayload = z.infer<typeof fundAccountTransactionsKind.payload>;

/** `details` of an applied `fund_account.transactions`. */
export type FundAccountTransactionsApplyDetails = {
  applied: boolean;
  accounts_ensured: number;
  /** Transactions an existing flow covers (a single-leg row, a transfer leg, an earlier import). */
  matched: number;
  /** Transactions no flow covers — added when applied. `account` is the fund account's import key. */
  missing: { account: string; date: string; amount_clp: number }[];
  /** Flows on the fund accounts no transaction covers (manual entries, older certificates) — never changed. */
  db_only: { account: string; date: string; amount_clp: number; kind: string }[];
  /** Unit values recorded from the certificate. */
  fund_unit_rows: number;
};
