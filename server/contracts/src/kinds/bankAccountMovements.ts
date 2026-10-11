import { z } from "zod";
import { defineIngestKind } from "../defineKind.js";

export const bankAccountCurrencySchema = z.enum(["clp", "usd"]);
export type BankAccountCurrency = z.infer<typeof bankAccountCurrencySchema>;

/** A bank account as the feeder knows it; the server maps it to its own account. */
export const issuerBankAccountSchema = z
  .object({
    /** Issuer slug, e.g. `santander`. */
    issuer: z.string().regex(/^[a-z][a-z0-9_]*$/),
    /** `checking`: a cuenta corriente, in pesos or in dollars. */
    product: z.enum(["checking"]),
    /** The currency the account is kept in; every row is in it (v2, 2026-10-10). */
    currency: bankAccountCurrencySchema,
    /**
     * The account number the document itself names (digits only, leading zeros as printed), when
     * it names one — a listing of the wrong account must be refused, not filed under the mapped
     * one. A dollar listing must name it: the dollar account is found by its number.
     */
    number: z.string().regex(/^\d+$/).optional(),
  })
  .strict();

export const bankAccountMovementSchema = z
  .object({
    /** The bank's posting date (Santander dates a wire after its 14:00 cutoff on the next workday). */
    date: z.iso.date(),
    /** The bank's description, whitespace collapsed; the document number, when printed, leads it. */
    description: z.string().trim().min(1).max(180),
    currency: bankAccountCurrencySchema,
    /**
     * Signed as the account sees it: a credit positive, a debit negative. Never zero; whole pesos
     * for a peso row, cents (two decimals at most) for a dollar row.
     */
    amount: z.number().finite().refine((n) => n !== 0, { message: "amount is never zero" }),
    /** The bank's document number, when the row prints one. */
    document_no: z.string().regex(/^\d+$/).nullable(),
    /**
     * The bank's reference for a credit it files as an incoming wire (Santander: the payment
     * order number of a «Rec Or de Pago»), null on any other row. A credit that carries one is
     * money a wire notice books (`bank_account.incoming_wires`), never a deposit of its own.
     */
    wire_reference: z.string().trim().min(1).max(64).nullable(),
  })
  .strict()
  .refine((m) => (m.currency === "clp" ? Number.isInteger(m.amount) : Math.round(m.amount * 100) === m.amount * 100), {
    message: "a peso amount is whole pesos; a dollar amount has at most two decimals",
    path: ["amount"],
  });

export type BankAccountMovement = z.infer<typeof bankAccountMovementSchema>;

/**
 * A bank account's recent movements as the bank lists them — a partial window, not a statement:
 * no opening or closing balance, and rows already on file (or already covered by the month's
 * statement, or by a transfer the ledger holds) are repeats the server skips. `rejected_rows`:
 * rows the feeder could not read, kept with the import's record (the feeder still fails the run).
 *
 * v2 (2026-10-10): the account states its currency and a dollar account's rows carry cents and,
 * on an incoming wire, the bank's wire reference.
 */
export const bankAccountMovementsKind = defineIngestKind({
  kind: "bank_account.movements",
  schema_version: 2,
  description: "A bank account's recent movements (a partial listing, not a statement).",
  payload: z
    .object({
      account: issuerBankAccountSchema,
      movements: z.array(bankAccountMovementSchema),
      rejected_rows: z.array(z.string().min(1)),
    })
    .strict()
    .refine((p) => p.movements.every((m) => m.currency === p.account.currency), {
      message: "every movement is in the account's currency",
      path: ["movements"],
    }),
});

export type BankAccountMovementsPayload = z.infer<typeof bankAccountMovementsKind.payload>;

/** `details` of an applied `bank_account.movements` result for a PESO account. */
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

/**
 * `details` of an applied `bank_account.movements` result for a DOLLAR account, whose rows the
 * ledger already holds from their documents (a wire's notices, a card payment entered by hand, a
 * conversion): the listing confirms them and never inserts. `confirmed`: rows a ledger transfer
 * leg explains (its bank posting day recorded); `awaiting_wire_booking`: incoming wires whose
 * notices have not booked yet (sent again next run); `unexplained`: rows no ledger row explains —
 * the feeder fails its step on them, since a dollar row the app does not know about is a row to
 * enter, not to guess at.
 */
export type UsdAccountMovementsApplyDetails = {
  account_id: number;
  batch_id: number;
  confirmed: number;
  awaiting_wire_booking: number;
  unexplained: number;
  confirmed_flows: { occurred_on: string; description: string; amount: number; movement_id: number }[];
  awaiting_flows: { occurred_on: string; description: string; amount: number; wire_reference: string }[];
  unexplained_flows: { occurred_on: string; description: string; amount: number }[];
};
