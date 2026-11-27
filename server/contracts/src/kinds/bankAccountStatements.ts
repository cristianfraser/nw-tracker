import { z } from "zod";
import { isCartolaText, isoDateSchema, yearMonthSchema } from "../formats/index.js";
import { defineIngestKind } from "../defineKind.js";

const pesos = z.number().int();

/** A printed cell in the shared cartola reading (`formats/cartolaText.ts`): every reader stores it so. */
const cartolaCell = z.string().refine(isCartolaText, { message: "not in the shared cartola reading (cartolaText): spaces, accent damage" });

/** A bank account as the issuer names its product; the server maps it to its own account. */
export const bankStatementAccountSchema = z
  .object({
    issuer: z.enum(["santander"]),
    /** `checking`: cuenta corriente; `demand_deposit`: cuenta vista. */
    product: z.enum(["checking", "demand_deposit"]),
  })
  .strict();

/**
 * One movement as the statement prints it, its cells in the shared reading (`cartolaText`), so the
 * xlsx and the PDF of a month state it alike. Its printed fields key the ledger row (the movement note).
 */
export const bankStatementMovementSchema = z
  .object({
    date: isoDateSchema,
    branch: cartolaCell,
    description: cartolaCell,
    document_no: cartolaCell,
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
    period_month: yearMonthSchema,
    period_from: isoDateSchema.nullable(),
    period_to: isoDateSchema.nullable(),
    opening_balance: pesos.nullable(),
    closing_balance: pesos.nullable(),
    /** The closing balance of each calendar month the period spans, when the statement prints a daily balance. */
    month_closing_balances: z.record(yearMonthSchema, pesos).nullable(),
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
 * each period it has not imported yet into a ledger that agrees with its printed balances (a
 * period imported already only refreshes its printed balances, is cross-checked by another
 * document covering the whole month, or is replaced by a fuller partial one); each statement is
 * applied or refused on its own.
 */
export const bankAccountStatementsKind = defineIngestKind({
  kind: "bank_account.statements",
  schema_version: 3,
  description: "A bank account's statements (cartolas): periods, printed balances and movements.",
  ref: "read",
  payload: z
    .object({
      account: bankStatementAccountSchema,
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
  files: {
    file: string;
    period_month: string;
    /**
     * imported | dry_run | skipped_already_imported | updated_saldo_ref | parse_error | confirmed
     * (a second document stated the month on file alike) | refused (the ledger does not agree with
     * it, or it states a month on file differently: nothing of it written, `problems` says why).
     */
    status: string;
    movements_parsed: number;
    movements_imported: number;
    error: string | null;
    /** A refused statement's reasons, one per line (empty otherwise). */
    problems: string[];
  }[];
  /** The import's own log, line by line, as the feeder prints it. */
  report: string[];
};
