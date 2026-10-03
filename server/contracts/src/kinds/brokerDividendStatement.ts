import { z } from "zod";
import { defineIngestKind } from "../defineKind.js";

/**
 * A broker document that itemizes dividends with their withholding: a monthly statement or a
 * certificate of capital events. The ledger already holds each dividend at the NET amount the
 * account received (from the notification mails); the document adds the gross and the tax
 * withheld abroad, which the server stores beside the ledger row it pairs the dividend with. It
 * never creates or changes a movement.
 */

const isoDate = z.iso.date();
const cents = z.number().nonnegative();

export const statementDividendSchema = z
  .object({
    /** The date the document prints for the dividend (its payment date). */
    date: isoDate,
    symbol: z.string().regex(/^[A-Z][A-Z0-9.]{0,9}$/),
    gross: cents,
    withholding: cents,
    net: cents,
    per_share: z.number().positive().nullable(),
    position_qty: z.number().positive().nullable(),
    record_date: isoDate.nullable(),
    withholding_rate_pct: z.number().nonnegative().nullable(),
    /** Who withheld the tax, when the document names it (`US`: IRS nonresident-alien withholding). */
    withholding_jurisdiction: z.string().regex(/^[A-Z]{2}$/).nullable(),
    /** The payee's tax country as printed (`CHL`). */
    tax_country: z.string().regex(/^[A-Z]{2,3}$/).nullable(),
  })
  .strict()
  .refine((d) => Math.abs(d.gross - d.withholding - d.net) <= 0.015, { message: "gross − withholding must be the net" });

export type StatementDividend = z.infer<typeof statementDividendSchema>;

export const brokerDividendStatementKind = defineIngestKind({
  kind: "broker.dividend_statement",
  schema_version: 1,
  description: "A broker document itemizing dividends (gross, withholding, net) and sweep interest.",
  payload: z
    .object({
      /** False: report the pairing, write nothing. */
      apply: z.boolean(),
      broker: z.enum(["fintual"]),
      document: z
        .object({
          /** `monthly_statement`: the custodian's monthly cartola; `certificate`: a certificate of capital events. */
          kind: z.enum(["monthly_statement", "certificate"]),
          /** The file name: provenance, kept on each breakdown it writes. */
          name: z.string().min(1).max(256),
          /** The statement period `YYYY-MM`, or the certificate's issue date. */
          label: z.string().min(1).max(32),
        })
        .strict(),
      dividends: z.array(statementDividendSchema),
      /** Interest on the cash sweep — reported, never booked. */
      interest: z.array(z.object({ date: isoDate, amount: cents, description: z.string().min(1).max(200) }).strict()),
    })
    .strict(),
});

export type BrokerDividendStatementPayload = z.infer<typeof brokerDividendStatementKind.payload>;

/** `details` of an applied `broker.dividend_statement`. */
export type BrokerDividendStatementApplyDetails = {
  applied: boolean;
  dividends: {
    dividend: StatementDividend;
    /** The ledger's `dividend_payout` row, when exactly one matches. */
    movement_id: number | null;
    /** The same breakdown already stands (from this document class or a better one). */
    already_recorded: boolean;
    /** Why the dividend could not be paired: the document and the ledger disagree. */
    conflict: string | null;
    /** What the write did (`inserted`, `updated`, `unchanged`, …); null in a dry run or on a conflict. */
    outcome: string | null;
  }[];
};
