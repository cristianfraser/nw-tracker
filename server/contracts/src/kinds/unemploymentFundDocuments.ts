import { z } from "zod";
import { defineIngestKind } from "../defineKind.js";

/**
 * The unemployment fund's documents (AFC Chile, Cuenta Individual por Cesantía): the certificate
 * of paid contributions and any number of four-monthly statements, as printed. The server
 * rebuilds the account's cuota ledger from them — each contribution at the unit value of its pay
 * date, each withdrawal at the unit value of its date (or closing the position), and one true-up
 * per printed balance for the commission the fund deducts in units. Report-first: without
 * `apply` every change is rolled back after the report.
 */

const isoDate = z.iso.date();
const periodMonth = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const pesos = z.number().int();

export const unemploymentFundCertificateSchema = z
  .object({
    /** One row per printed leg (worker and employer legs of a period are separate rows). */
    legs: z
      .array(
        z
          .object({
            period_month: periodMonth,
            employer_rut: z.string().min(1).max(20),
            /** Empty when the layout wrapped the name onto lines of its own. */
            employer: z.string().max(200),
            taxable_income: pesos.nonnegative(),
            amount: pesos.positive(),
            /** Fecha de pago: the day the fund credits the units. */
            paid_on: isoDate,
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
    period_from: isoDate,
    period_to: isoDate,
    opening: z.object({ date: isoDate, balance: pesos }).strict(),
    closing: z.object({ date: isoDate, balance: pesos }).strict(),
    contributions: pesos,
    other_income: pesos,
    gain: pesos,
    total_income: pesos,
    commissions: pesos,
    other_outflows: pesos,
    account_use: pesos,
    total_outflows: pesos,
    /** Contributions by month of payment. */
    detail: z.array(z.object({ employer: z.string().min(1).max(200), pay_month: periodMonth, amount: pesos }).strict()),
  })
  .strict()
  .refine((s) => s.opening.balance + s.total_income - s.total_outflows === s.closing.balance, {
    message: "closing ≠ opening + income − outflows",
  });

export type UnemploymentFundCertificate = z.infer<typeof unemploymentFundCertificateSchema>;
export type UnemploymentFundStatement = z.infer<typeof unemploymentFundStatementSchema>;

export const unemploymentFundDocumentsKind = defineIngestKind({
  kind: "unemployment_fund.documents",
  schema_version: 1,
  description: "Unemployment fund (AFC) documents: the certificate of paid contributions and four-monthly statements.",
  payload: z
    .object({
      /** False: report the rebuild and roll every change back. */
      apply: z.boolean(),
      provider: z.enum(["afc"]),
      /** The fund account; null: the one account on the fund's unit-value series. */
      account_id: z.number().int().positive().nullable(),
      certificate: unemploymentFundCertificateSchema,
      statements: z.array(unemploymentFundStatementSchema),
      /**
       * One-off rebuild choices on rows already in the ledger: delete the excel-era contribution
       * rows the certificate supersedes, and these excel-era movement ids.
       */
      options: z
        .object({ replace_excel_rows: z.boolean(), drop_movement_ids: z.array(z.number().int().positive()) })
        .strict(),
    })
    .strict(),
});

export type UnemploymentFundDocumentsPayload = z.infer<typeof unemploymentFundDocumentsKind.payload>;

/** `details` of an applied `unemployment_fund.documents`: the rebuild's report, line by line. */
export type UnemploymentFundDocumentsApplyDetails = {
  applied: boolean;
  account_id: number;
  report: string[];
};
