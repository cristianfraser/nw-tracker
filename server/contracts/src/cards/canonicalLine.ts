import { z } from "zod";
import { CARD_LINE_KINDS } from "../flowKinds.js";
import { isoDateSchema } from "../formats/index.js";

/**
 * The canonical card line (docs/untangle-plan.md F13): the one shape a card statement line has
 * inside the server, whatever document it came from — the statement parser's CSV, the statement
 * JSON, a feed listing, a pasted table, a planted payment, the demo. Every source converts its own
 * shape into this ONCE, at its boundary; the import (`importCcStatementsMerge`) and the line
 * funnel (`cards/lineWrites.ts`) store it as it is.
 *
 * - **Debt-positive:** a charge is positive, a payment or credit negative, in `currency` (the
 *   currency the line's amount is in — a dollar line on a peso listing bucket is `usd`).
 * - **Kind** is stamped by the one classifier (`cardLineKind`, `lineRules.ts`) when the line is
 *   built, from its sign, wording and installment flag.
 * - **Days** are ISO. The text a document printed for them, when it printed one, rides beside in
 *   `printed_*` and is what the ledger stores (`cc_statement_lines.transaction_date` keeps the
 *   statement's own text; a source with no printed text stores the day unpadded, `7/9/2026`).
 * - **Document provenance** (`document`) is what the import keys a line on: the document's own
 *   line id and dedupe key (a same-statement twin carries `#dupN`), the section of the document the
 *   parser read it from, and the raw text.
 */
export const cardCanonicalInstallmentSchema = z
  .object({
    /** The cuota this line bills (null: a «00/N» purchase row, bought this cycle). */
    number: z.number().int().nullable(),
    count: z.number().int().nullable(),
    /** The monthly cuota in pesos. */
    cuota_amount: z.number().int().nullable(),
    /** The plan's principal as the document prints it (its total to pay, or the operation's amount). */
    total_amount: z.number().int().nullable(),
    interest_rate_text: z.string().nullable(),
    cuota_type: z.string().nullable(),
    /** The document's identity for the plan (the parser's canonical row id), when it names one. */
    plan_id: z.string().nullable(),
  })
  .strict();

export const cardCanonicalLineSchema = z
  .object({
    kind: z.enum(CARD_LINE_KINDS),
    transaction_date: isoDateSchema.nullable(),
    posting_date: isoDateSchema.nullable(),
    printed_transaction_date: z.string().nullable(),
    printed_posting_date: z.string().nullable(),
    merchant: z.string(),
    description: z.string().nullable(),
    place: z.string().nullable(),
    country: z.string().nullable(),
    currency: z.enum(["clp", "usd"]),
    /** Debt-positive, in `currency`. */
    amount: z.number(),
    /** The amount in the currency the merchant charged, as printed (its currency is labeled on import). */
    origin_amount: z.number().nullable(),
    installment: cardCanonicalInstallmentSchema.nullable(),
    /** The plastic that made the movement, when the document says (an additional card's last4). */
    origin_card_last4: z.string().nullable(),
    /**
     * A listing's purchase in cuotas, listed at its full principal (`card.unbilled_movements`
     * `cuota_purchase`, the import's own vocabulary); null on statement lines.
     */
    cuota_purchase: z
      .object({
        kind: z.enum(["cuota_comercio", "precio_contado"]),
        cuota_count: z.number().int().positive().nullable(),
        count_source: z.enum(["stamp_tax", "feed_type"]).nullable(),
        stamp_tax_clp: z.number().int().nullable(),
      })
      .strict()
      .nullable(),
    document: z
      .object({
        /** The document's own line id (the parser's row id, `json:…`, `web:…`). */
        line_id: z.string().nullable(),
        /** The document's dedupe key (`#dupN` on the Nth same-statement twin). */
        dedupe_key: z.string().nullable(),
        /** The part of the document the line was read from (the parser layout; `compact` elsewhere). */
        section: z.string(),
        raw_text: z.string().nullable(),
        /** The parser saw the same line on another statement (its copy is the less preferred one). */
        duplicate_across_statements: z.boolean(),
        /** A baseline purchase the parser matched the plan to, as it names it. */
        baseline_match: z.string().nullable(),
      })
      .strict(),
  })
  .strict();

export type CardCanonicalLine = z.infer<typeof cardCanonicalLineSchema>;
export type CardCanonicalInstallment = z.infer<typeof cardCanonicalInstallmentSchema>;

/** What a statement's header prints (null: not printed). Amounts in the statement's currency. */
export const cardCanonicalStatementHeaderSchema = z
  .object({
    saldo_anterior: z.number().nullable(),
    abono: z.number().nullable(),
    compras_cargos: z.number().nullable(),
    deuda_total: z.number().nullable(),
    monto_facturado: z.number().nullable(),
    monto_facturado_anterior: z.number().nullable(),
    monto_pagado_anterior: z.number().nullable(),
    /** The day the previous facturación's payment was made (ISO), when the document dates it. */
    monto_pagado_anterior_date: isoDateSchema.nullable(),
    /** The following cycle as printed, zero-padded `DD/MM/YYYY`. */
    next_period_from: z.string().nullable(),
    next_period_to: z.string().nullable(),
    /** The parser's «TOTAL OPERACIONES» (the import reconcile's anchor). */
    pdf_total_operaciones: z.number().nullable(),
  })
  .strict();

export type CardCanonicalStatementHeader = z.infer<typeof cardCanonicalStatementHeaderSchema>;

/**
 * One statement of one card, in one currency: a facturación's document (a PDF, the statement JSON,
 * the demo's) or a listing's open bucket. `document` + `card_group` + `close` are its identity in
 * the ledger (`cc_statements`); the dates are the document's text (`DD/MM/YYYY`).
 */
export const cardCanonicalStatementSchema = z
  .object({
    document: z.string().min(1),
    card_group: z.string(),
    close: z.string(),
    period_from: z.string().nullable(),
    period_to: z.string().nullable(),
    pay_by: z.string().nullable(),
    card_last4: z.string().nullable(),
    card_product: z.string().nullable(),
    currency: z.enum(["clp", "usd"]),
    /** How the ledger files the document's layout. */
    layout: z.enum(["compact", "wide", "international_usd"]),
    header: cardCanonicalStatementHeaderSchema,
    lines: z.array(cardCanonicalLineSchema),
  })
  .strict();

export type CardCanonicalStatement = z.infer<typeof cardCanonicalStatementSchema>;

export const EMPTY_CARD_STATEMENT_HEADER: CardCanonicalStatementHeader = Object.freeze({
  saldo_anterior: null,
  abono: null,
  compras_cargos: null,
  deuda_total: null,
  monto_facturado: null,
  monto_facturado_anterior: null,
  monto_pagado_anterior: null,
  monto_pagado_anterior_date: null,
  next_period_from: null,
  next_period_to: null,
  pdf_total_operaciones: null,
});

/** The ledger's statement identity, `card_group\tdocument\tclose`. */
export function cardStatementKey(s: Pick<CardCanonicalStatement, "card_group" | "document" | "close">): string {
  return `${s.card_group}\t${s.document}\t${s.close}`;
}

/** The ledger's layout for a document layout name (the parser's `parser_layout`). */
export function cardStatementLayout(parserLayout: string): CardCanonicalStatement["layout"] {
  const layout = parserLayout.trim();
  if (layout === "international_usd") return "international_usd";
  if (layout.startsWith("wide")) return "wide";
  return "compact";
}

/** `2026-07-23` → `23/7/2026`: how a day with no printed text is stored. */
export function unpaddedCardLineDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) throw new Error(`Expected an ISO date, got "${iso}"`);
  return `${Number(m[3])}/${Number(m[2])}/${m[1]}`;
}

/** The transaction date as the ledger stores it: the document's text, else the day unpadded. */
export function storedCardLineDate(printed: string | null, iso: string | null): string | null {
  if (printed != null && printed.trim() !== "") return printed.trim();
  return iso ? unpaddedCardLineDate(iso) : null;
}
