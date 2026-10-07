import { z } from "zod";
import { defineIngestKind } from "../defineKind.js";

/** A bank account as the feeder knows it; the server maps it to its own account. */
export const issuerBankAccountSchema = z
  .object({
    /** Issuer slug, e.g. `santander`. */
    issuer: z.string().regex(/^[a-z][a-z0-9_]*$/),
    /** `checking`: the cuenta corriente. */
    product: z.enum(["checking"]),
  })
  .strict();

export const bankAccountMovementSchema = z
  .object({
    /** The bank's posting date (Santander dates a wire after its 14:00 cutoff on the next workday). */
    date: z.iso.date(),
    /** The bank's description, whitespace collapsed; the document number, when printed, leads it. */
    description: z.string().trim().min(1).max(180),
    currency: z.literal("clp"),
    /** Signed as the account sees it: a credit positive, a debit negative. Whole pesos, never zero. */
    amount: z.number().int().refine((n) => n !== 0, { message: "amount is never zero" }),
    /** The bank's document number, when the row prints one. */
    document_no: z.string().regex(/^\d+$/).nullable(),
  })
  .strict();

export type BankAccountMovement = z.infer<typeof bankAccountMovementSchema>;

/**
 * A bank account's recent movements as the bank lists them — a partial window, not a statement:
 * no opening or closing balance, and rows already on file (or already covered by the month's
 * statement, or by a transfer the ledger holds) are repeats the server skips. `rejected_rows`:
 * rows the feeder could not read, kept with the import's record (the feeder still fails the run).
 */
export const bankAccountMovementsKind = defineIngestKind({
  kind: "bank_account.movements",
  schema_version: 1,
  description: "A bank account's recent movements (a partial listing, not a statement).",
  payload: z
    .object({
      account: issuerBankAccountSchema,
      movements: z.array(bankAccountMovementSchema),
      rejected_rows: z.array(z.string().min(1)),
    })
    .strict(),
});

export type BankAccountMovementsPayload = z.infer<typeof bankAccountMovementsKind.payload>;

/** `details` of an applied `bank_account.movements` result. */
export type BankAccountMovementsApplyDetails = {
  account_id: number;
  batch_id: number;
  inserted: number;
  skipped_duplicate: number;
  skipped_superseded_by_cartola: number;
  skipped_superseded_by_transfer: number;
  /** Credits already written from the transfer's mail during the day. */
  skipped_superseded_by_mail: number;
  inserted_flows: { occurred_on: string; description: string; amount_clp: number }[];
  skipped_flows: { occurred_on: string; description: string; amount_clp: number; reason: string }[];
};
