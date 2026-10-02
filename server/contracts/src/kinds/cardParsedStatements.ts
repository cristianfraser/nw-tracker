import { z } from "zod";
import { defineIngestKind } from "../defineKind.js";

/**
 * The columns of a card statement parser's output, one row per statement line — the shape the
 * PDF statement parser (`parse-cc-statement-pdfs.py`) writes to `cc-statements-parsed-all.csv`.
 * Every statement-level field rides on each of its lines (`statement_*`, `pdf_total_operaciones`).
 *
 * The rows travel verbatim, as the parser printed them: the server keeps a hash of each
 * statement's rows (`import_fingerprint`) to re-import only what changed, and keys stored line
 * identities on the parser's own (`dedupe_key`, `row_id`, `canonical_row_id`).
 */
export const CARD_PARSED_STATEMENT_COLUMNS = [
  "card_group",
  "source_pdf",
  "statement_date",
  "period_from",
  "period_to",
  "pay_by",
  "card_last4",
  "origin_card_last4",
  "card_product",
  "parser_layout",
  "raw_line",
  "transaction_date",
  "posting_date",
  "place",
  "merchant",
  "description_merged",
  "amount_clp",
  "monto_total_a_pagar_clp",
  "monto_origen_operacion_clp",
  "installment_flag",
  "nro_cuota_current",
  "nro_cuota_total",
  "valor_cuota_mensual_clp",
  "interest_rate_text",
  "tipo_cuota",
  "foreign_currency",
  "authorization_code",
  "dedupe_key",
  "is_duplicate_across_statements",
  "canonical_row_id",
  "row_id",
  "matched_excel_row",
  "match_confidence",
  "mismatch_notes",
  "currency",
  "amount_usd",
  "amount_orig",
  "orig_currency",
  "country",
  "statement_saldo_anterior",
  "statement_monto_facturado_anterior",
  "statement_monto_pagado_anterior",
  "statement_monto_pagado_anterior_date",
  "statement_next_period_from",
  "statement_next_period_to",
  "statement_abono",
  "statement_compras_cargos",
  "statement_deuda_total",
  "statement_monto_facturado",
  "pdf_total_operaciones",
] as const;

export type CardParsedStatementColumn = (typeof CARD_PARSED_STATEMENT_COLUMNS)[number];

/**
 * Every card statement a statement parser read — all of them, each run: the server imports the
 * statements whose rows changed since their last import (`full` re-imports every one) and routes
 * each line to its card account by `card_last4`. Columnar, so a corpus of thousands of lines fits
 * one request: `columns` once, then each line's values in that order.
 */
export const cardParsedStatementsKind = defineIngestKind({
  kind: "card.parsed_statements",
  schema_version: 1,
  description: "Every card statement a statement parser read, line by line, as the parser printed it.",
  payload: z
    .object({
      /** False: report what an import would do, write nothing. */
      apply: z.boolean(),
      /** Re-import and re-reconcile every statement, not only the changed ones. */
      full: z.boolean(),
      columns: z.array(z.enum(CARD_PARSED_STATEMENT_COLUMNS)),
      rows: z.array(z.array(z.string())).min(1),
    })
    .strict()
    .superRefine((p, ctx) => {
      const seen = new Set(p.columns);
      const missing = CARD_PARSED_STATEMENT_COLUMNS.filter((c) => !seen.has(c));
      if (seen.size !== p.columns.length || missing.length > 0) {
        ctx.addIssue({ code: "custom", path: ["columns"], message: `every column exactly once (missing: ${missing.join(", ") || "none"})` });
      }
      p.rows.forEach((row, i) => {
        if (row.length !== p.columns.length) {
          ctx.addIssue({ code: "custom", path: ["rows", i], message: `${row.length} values for ${p.columns.length} columns` });
        }
      });
    }),
});

export type CardParsedStatementsPayload = z.infer<typeof cardParsedStatementsKind.payload>;

/** `details` of an applied `card.parsed_statements`. */
export type CardParsedStatementsApplyDetails = {
  applied: boolean;
  accounts: {
    account_id: number;
    label: string;
    statements_unchanged: number;
    statements_imported: number;
    lines_inserted: number;
    lines_skipped_duplicate: number;
    lines_skipped_installment_overlap: number;
    purchase_upserts: number;
    payment_upserts: number;
  }[];
  /** The import's own log, line by line, as the feeder prints it. */
  report: string[];
  /** Data errors that fail the step (lines no card account takes). */
  problems: string[];
};
