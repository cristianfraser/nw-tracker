import { z } from "zod";
import { defineIngestKind } from "../defineKind.js";

const text = z.string().trim().min(1);
const bankSlug = z.string().regex(/^[a-z][a-z0-9_]*$/);

/**
 * One mail about a wire INTO one of the client's accounts, as the mail states it. Two banks mail
 * about the same wire: the sending bank (a copy of the SWIFT MT103 it sent, Banco Security for
 * Fintual's dollar withdrawals) and the receiving one (Santander's «orden de pago recibida»). The
 * server groups the notices of one wire and books it.
 */
export const incomingWireNoticeSchema = z
  .object({
    /** The mail's Message-ID: the notice's identity. */
    message_id: text,
    /** When the bank sent it, on the Chile clock: `YYYY-MM-DD HH:MM`. */
    sent_at_chile: z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/),
    subject: z.string(),
    /** The bank that mailed it. */
    bank: bankSlug,
    reported_by: z.enum(["sending_bank", "receiving_bank"]),
    /** The value date the transfer message states, or the receiving bank's notice day. */
    value_date: z.iso.date(),
    currency: z.enum(["usd"]),
    /** As printed, to the cent. */
    amount: z
      .number()
      .positive()
      .refine((n) => Math.abs(Math.round(n * 100) - n * 100) < 1e-6, { message: "amount must be in cents" }),
    beneficiary: z
      .object({
        bank: bankSlug.nullable(),
        /** The account number as printed. Null when the notice names none (the receiving bank's own notice). */
        account: z.string().regex(/^\d+$/).nullable(),
        name: text.nullable(),
      })
      .strict(),
    ordering: z
      .object({
        name: text.nullable(),
        account: text.nullable(),
        bank: bankSlug.nullable(),
      })
      .strict(),
    /** The transfer's own reference (sender's reference, payment order number). */
    reference: text.nullable(),
    /** The remittance information the sender wrote. */
    remittance: text.nullable(),
  })
  .strict();

export type IncomingWireNotice = z.infer<typeof incomingWireNoticeSchema>;

export const bankAccountIncomingWiresKind = defineIngestKind({
  kind: "bank_account.incoming_wires",
  schema_version: 1,
  description: "Wires into the client's accounts, as the sending and receiving banks mailed them.",
  payload: z
    .object({
      apply: z.boolean(),
      notices: z.array(incomingWireNoticeSchema),
    })
    .strict()
    .superRefine((p, ctx) => {
      const seen = new Set<string>();
      for (const n of p.notices) {
        if (seen.has(n.message_id)) ctx.addIssue({ code: "custom", message: `notice ${n.message_id} listed twice` });
        seen.add(n.message_id);
      }
    }),
});

export type BankAccountIncomingWiresPayload = z.infer<typeof bankAccountIncomingWiresKind.payload>;

/** What the server did (or would do) with the stored withdrawal requests and wire notices. */
export type IncomingWireBookingReport = {
  /** Withdrawals booked by this call (or that would be, without `apply`). */
  booked: {
    request_message_id: string;
    value_date: string;
    currency: "usd";
    net_amount: number;
    fee_amount: number;
    from_account_id: number;
    to_account_id: number;
    /** Null when not applied. */
    transfer_movement_id: number | null;
    fee_movement_id: number | null;
    /** The transfer was already in the ledger (entered by hand): only the booking was recorded. */
    already_in_ledger: boolean;
    notices: string[];
  }[];
  /** Requests still waiting for their wire. `overdue`: past its pay day by more than 3 days. */
  waiting: { request_message_id: string; due_on: string; net_amount: number; overdue: boolean }[];
  /** Wires no request claims (another sender, or a request mail not staged). */
  unmatched: { value_date: string; amount: number; account_id: number | null; notices: string[] }[];
  ambiguous: string[];
};

/** `details` of an applied `bank_account.incoming_wires`. */
export type BankAccountIncomingWiresApplyDetails = {
  applied: boolean;
  received: number;
  new_notices: number;
  bookings: IncomingWireBookingReport;
};
