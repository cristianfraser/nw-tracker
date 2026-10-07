import { z } from "zod";
import { defineIngestKind } from "../defineKind.js";

const text = z.string().trim().min(1);

export const transferPartySchema = z
  .object({
    name: text.nullable(),
    rut: text.nullable(),
    bank: text.nullable(),
    account_type: text.nullable(),
    /** The account number as the bank printed it (dashes or not). */
    account_number: text.nullable(),
    email: text.nullable(),
  })
  .strict();

export type TransferParty = z.infer<typeof transferPartySchema>;

export const transferNoticeSchema = z
  .object({
    /** The mail's Message-ID: the notice's identity. */
    message_id: text,
    /** When the bank sent it, on the Chile clock: `YYYY-MM-DD HH:MM`. */
    sent_at_chile: z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/),
    subject: z.string(),
    /**
     * `outgoing`: the client sent money (to a third party or an own account elsewhere);
     * `incoming`: someone sent money to the client; `between_own_products`: between two of the
     * client's accounts at the issuer; `schedule_created`: a scheduled transfer was set up (no
     * money moved).
     */
    kind: z.enum(["outgoing", "incoming", "between_own_products", "schedule_created"]),
    /** The day the mail states. */
    date: z.iso.date(),
    /** Pesos, as printed. */
    amount: z.number().int().positive(),
    from: transferPartySchema,
    to: transferPartySchema,
    comment: text.nullable(),
    /** A scheduled transfer running. */
    scheduled: z.boolean(),
  })
  .strict();

export type TransferNotice = z.infer<typeof transferNoticeSchema>;

/**
 * The transfer notices a bank mailed its client: one per transfer it states, decoded from its mail.
 * Several mails can state one transfer (a receipt and the recipient's notice of a transfer between
 * two of the client's own accounts); the server pairs each bank movement with at most one.
 */
export const bankAccountTransferNoticesKind = defineIngestKind({
  kind: "bank_account.transfer_notices",
  schema_version: 1,
  description: "Transfers a bank mailed its client about, each with its counterparty.",
  payload: z
    .object({
      issuer: z.string().regex(/^[a-z][a-z0-9_]*$/),
      notices: z.array(transferNoticeSchema),
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

export type BankAccountTransferNoticesPayload = z.infer<typeof bankAccountTransferNoticesKind.payload>;

/** `details` of an applied `bank_account.transfer_notices` result. */
export type BankAccountTransferNoticesApplyDetails = {
  received: number;
  new_notices: number;
  /** After the re-pairing of every stored notice. */
  paired: number;
  /** Notices left unpaired, by reason (echoes, untracked accounts, no bank row yet…). */
  unpaired: Record<string, number>;
  /** Mails whose candidate bank rows the matcher could not tell apart (left unpaired). */
  ambiguous: string[];
  /** Credits written from an incoming transfer's mail because no bank feed lists it yet. */
  synthesized: { message_id: string; movement_id: number; account_id: number; date: string; amount: number }[];
  /** Such credits no bank feed has listed by their deadline: the promised money never appeared. */
  overdue: { message_id: string; movement_id: number; date: string; amount: number; deadline: string | null }[];
};
