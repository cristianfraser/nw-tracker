import { z } from "zod";
import { defineIngestKind } from "../defineKind.js";

const isoDate = z.iso.date();
const periodMonth = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const pesos = z.number().int();

/** A bank account as the issuer names its product; the server maps it to its own account. */
export const bankStatementAccountSchema = z
  .object({
    issuer: z.enum(["santander"]),
    /** `checking`: cuenta corriente; `demand_deposit`: cuenta vista. */
    product: z.enum(["checking", "demand_deposit"]),
  })
  .strict();

/** One movement as the statement prints it. Its printed fields key the ledger row (the movement note). */
export const bankStatementMovementSchema = z
  .object({
    date: isoDate,
    branch: z.string(),
    description: z.string(),
    document_no: z.string(),
    /** Signed: a credit positive, a debit negative. */
    amount: pesos,
  })
  .strict();

/** A row the parser read and left out, with why (reported in the import log). */
export const bankStatementSkippedRowSchema = z
  .object({
    sheet_row: z.number().int().optional(),
    fecha: z.string().optional(),
    branch: z.string().optional(),
    description: z.string().optional(),
    document_no: z.string().optional(),
    amount_clp: z.number().optional(),
    reason: z.enum(["not_movement_row", "no_amount", "duplicate_in_cartola", "end_of_table", "balance_mismatch"]),
    detail: z.string().optional(),
  })
  .strict();

/** One statement (cartola) for its period. */
export const bankAccountStatementSchema = z
  .object({
    /** The document it came from (a file name): provenance, and the import log's label. */
    document: z.string().min(1).max(512),
    period_month: periodMonth,
    period_from: isoDate.nullable(),
    period_to: isoDate.nullable(),
    opening_balance: pesos.nullable(),
    closing_balance: pesos.nullable(),
    /** The closing balance of each calendar month the period spans, when the statement prints a daily balance. */
    month_closing_balances: z.record(periodMonth, pesos).nullable(),
    movements: z.array(bankStatementMovementSchema),
    skipped_rows: z.array(bankStatementSkippedRowSchema),
    /** What the parser inferred while reading (an amount taken from the balance column…), for the import log. */
    notes: z.array(z.object({ sheet_row: z.number().int(), message: z.string() }).strict()),
  })
  .strict();

export type BankAccountStatement = z.infer<typeof bankAccountStatementSchema>;

/** A statement the feeder could not read (reported in the import log as a parse error). */
export const unreadableBankStatementSchema = z
  .object({
    document: z.string().min(1).max(512),
    error: z.string().min(1),
  })
  .strict();

/**
 * A bank account's statements (cartolas), as many as the feeder read this run. The server imports
 * each period it has not imported yet (a period imported already only refreshes its printed
 * balances, or replaces an empty one), and re-derives the account's opening anchor from the latest.
 */
export const bankAccountStatementsKind = defineIngestKind({
  kind: "bank_account.statements",
  schema_version: 1,
  description: "A bank account's statements (cartolas): periods, printed balances and movements.",
  payload: z
    .object({
      account: bankStatementAccountSchema,
      /** False: report what an import would do, write nothing. */
      apply: z.boolean(),
      /** Re-import periods already imported (their movements are replaced). */
      force_reimport: z.boolean(),
      statements: z.array(bankAccountStatementSchema),
      unreadable: z.array(unreadableBankStatementSchema),
    })
    .strict(),
});

export type BankAccountStatementsPayload = z.infer<typeof bankAccountStatementsKind.payload>;

/** `details` of an applied `bank_account.statements`. */
export type BankAccountStatementsApplyDetails = {
  account_id: number;
  applied: boolean;
  files: {
    file: string;
    period_month: string;
    /** imported | dry_run | skipped_already_imported | updated_saldo_ref | parse_error */
    status: string;
    movements_parsed: number;
    movements_imported: number;
    error: string | null;
  }[];
  /** The import's own log, line by line, as the feeder prints it. */
  report: string[];
};
