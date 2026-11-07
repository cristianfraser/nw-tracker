import { z } from "zod";
import { isoDateSchema, yearMonthSchema } from "../formats/index.js";
import { defineIngestKind } from "../defineKind.js";

/**
 * The unemployment fund's documents (AFC Chile, Cuenta Individual por Cesantía): the certificate
 * of paid contributions and any number of four-monthly statements, as printed. The server
 * rebuilds the account's cuota ledger from them — each contribution at the unit value of its pay
 * date, each withdrawal at the unit value of its date (or closing the position), and one true-up
 * per printed balance for the commission the fund deducts in units. The account is the one on
 * the fund's unit-value series; a dry run (the envelope's `dry_run`) rolls every change back after
 * the report.
 */

const pesos = z.number().int();

export const unemploymentFundCertificateSchema = z
  .object({
    /** One row per printed leg (worker and employer legs of a period are separate rows). */
    legs: z
      .array(
        z
          .object({
            period_month: yearMonthSchema,
            employer_rut: z.string().min(1).max(20),
            /** Empty when the layout wrapped the name onto lines of its own. */
            employer: z.string().max(200),
            taxable_income: pesos.nonnegative(),
            amount: pesos.positive(),
            /** Fecha de pago: the day the fund credits the units. */
            paid_on: isoDateSchema,
          })
          .strict()
      )
      .min(1),
    /** The printed TOTAL. */
    total: pesos,
  })
  .strict()
  .refine((c) => c.legs.reduce((a, l) => a + l.amount, 0) === c.total, { message: "the legs must add up to the printed TOTAL" });

export const unemploymentFundStatementSchema = z
  .object({
    period_from: isoDateSchema,
    period_to: isoDateSchema,
    opening: z.object({ date: isoDateSchema, balance: pesos }).strict(),
    closing: z.object({ date: isoDateSchema, balance: pesos }).strict(),
    contributions: pesos,
    other_income: pesos,
    gain: pesos,
    total_income: pesos,
    commissions: pesos,
    other_outflows: pesos,
    account_use: pesos,
    total_outflows: pesos,
    /** Contributions by month of payment. */
    detail: z.array(z.object({ employer: z.string().min(1).max(200), pay_month: yearMonthSchema, amount: pesos }).strict()),
  })
  .strict()
  .refine((s) => s.opening.balance + s.total_income - s.total_outflows === s.closing.balance, {
    message: "closing ≠ opening + income − outflows",
  });

export type UnemploymentFundCertificate = z.infer<typeof unemploymentFundCertificateSchema>;
export type UnemploymentFundStatement = z.infer<typeof unemploymentFundStatementSchema>;

export const unemploymentFundDocumentsKind = defineIngestKind({
  kind: "unemployment_fund.documents",
  schema_version: 2,
  description: "Unemployment fund (AFC) documents: the certificate of paid contributions and four-monthly statements.",
  ref: "read",
  payload: z
    .object({
      provider: z.enum(["afc"]),
      certificate: unemploymentFundCertificateSchema,
      statements: z.array(unemploymentFundStatementSchema),
    })
    .strict(),
});

export type UnemploymentFundDocumentsPayload = z.infer<typeof unemploymentFundDocumentsKind.payload>;

/** `details` of an applied `unemployment_fund.documents`: the rebuild's report, line by line. */
export type UnemploymentFundDocumentsApplyDetails = {
  account_id: number;
  report: string[];
};
