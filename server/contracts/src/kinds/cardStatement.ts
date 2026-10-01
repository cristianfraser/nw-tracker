import { z } from "zod";
import { defineIngestKind } from "../defineKind.js";
import { issuerCardAccountSchema } from "./cardUnbilledMovements.js";

const isoDate = z.iso.date();
const currency = z.enum(["clp", "usd"]);

/**
 * What a statement line is:
 * - `purchase`: a charge (one-shot);
 * - `installment`: a cuota of a purchase in cuotas (see `installment`);
 * - `charge`: the issuer's own charge (insurance, stamp tax, interest);
 * - `payment`: a payment of the previous facturación;
 * - `credit_note`: a refund or reversal (nota de crédito);
 * - `credit`: any other credit (a dollar abono).
 */
export const CARD_STATEMENT_LINE_KINDS = ["purchase", "installment", "charge", "payment", "credit_note", "credit"] as const;

export const cardStatementLineSchema = z
  .object({
    kind: z.enum(CARD_STATEMENT_LINE_KINDS),
    transaction_date: isoDate,
    posting_date: isoDate.nullable(),
    merchant: z.string(),
    /** Debt-positive in the statement's currency: a charge positive, a payment or credit negative. An installment line bills its cuota. */
    amount: z.number(),
    /** The amount the merchant charged, in a currency the issuer does not name (international lines only). */
    origin_amount: z.number().nullable(),
    country: z.string().nullable(),
    place: z.string().nullable(),
    /** The plastic the line was charged to. */
    card_last4: z.string().regex(/^\d{4}$/).nullable(),
    authorization_code: z.string().nullable(),
    installment: z
      .object({
        /** This cuota's number (0 on the preamble the statement prints in the purchase's own cycle). */
        number: z.number().int().nonnegative(),
        count: z.number().int().positive(),
        cuota_amount: z.number(),
        total_amount: z.number(),
      })
      .strict()
      .nullable(),
    /** The row as the source rendered it (provenance). */
    raw_text: z.string(),
  })
  .strict()
  .refine((l) => (l.kind === "installment") === (l.installment != null), {
    message: "installment is set exactly on installment lines",
  })
  .refine((l) => l.kind === "installment" ? l.amount === l.installment!.cuota_amount : true, {
    message: "an installment line bills its cuota",
  });

export type CardStatementLine = z.infer<typeof cardStatementLineSchema>;

export const cardStatementCurrencySchema = z
  .object({
    currency,
    /** The document this side came from (a file name, a message id): provenance. */
    document: z.string().min(1).max(256),
    /** The facturado total the issuer states for this currency, when it states one. */
    billed_total: z.number().nullable(),
    /** The payments of the previous facturación the issuer states (positive), when it states them. */
    payments_total: z.number().nonnegative().nullable(),
    lines: z.array(cardStatementLineSchema),
  })
  .strict();

export type CardStatementCurrency = z.infer<typeof cardStatementCurrencySchema>;

/**
 * One facturación of a card account: its close, the dates the issuer prints with it, and the
 * statement of each currency it billed. The server writes it to the ledger unless a statement
 * document of higher rank (the PDF) already holds that close, in which case it is a cross-check.
 */
export const cardStatementKind = defineIngestKind({
  kind: "card.statement",
  schema_version: 1,
  description: "One facturación of a card account: close, dates and each currency's statement.",
  payload: z
    .object({
      account: issuerCardAccountSchema,
      /** The issuer's number for the statement (provenance). */
      statement_number: z.string().regex(/^\d+$/),
      close: isoDate,
      pay_by: isoDate.nullable(),
      /** The next close the issuer announces. */
      next_close: isoDate.nullable(),
      /** The titular plastic the statement is issued for. */
      titular_last4: z.string().regex(/^\d{4}$/).nullable(),
      apply: z.boolean(),
      statements: z.array(cardStatementCurrencySchema).min(1).max(2),
    })
    .strict()
    .refine((p) => new Set(p.statements.map((s) => s.currency)).size === p.statements.length, {
      message: "one statement per currency",
    }),
});

export type CardStatementPayload = z.infer<typeof cardStatementKind.payload>;

/**
 * What the server made of one currency's statement:
 *  - `clean`: a higher-rank document owns the close, and the cross-check reconciles
 *  - `written`: written from this statement, and the post-write check reconciles
 *  - `pending`: a write candidate a report-only send leaves unwritten
 *  - `empty`: no lines, nothing to check or write
 *  - `skipped`: not written on purpose (a dateless re-served cycle)
 *  - `dirty`: a problem the report names
 */
export type CardStatementOutcome = "clean" | "written" | "pending" | "empty" | "skipped" | "dirty";

/** `details` of an applied `card.statement`. */
export type CardStatementApplyDetails = {
  account_id: number;
  statements: {
    currency: "clp" | "usd";
    document: string;
    outcome: CardStatementOutcome;
    /** `pdf` when a PDF holds the close (cross-check only), `json` when this source does, null when nothing does yet. */
    owner: "pdf" | "json" | null;
    /** The report, line by line, as the feeder prints it. */
    report: string[];
  }[];
  /** Set when this send wrote the facturación. */
  written: { currencies: ("clp" | "usd")[]; lines_inserted: number } | null;
};
