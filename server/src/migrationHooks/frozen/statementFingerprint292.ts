/**
 * Frozen for migration 292's hook (`statementFingerprint292.ts`): the stored-columns fingerprint of
 * a card statement as `cards/statementStorage.ts` (`storedStatementFingerprint`) computed it on
 * 2026-11-15, over the columns `cc_statements` and `cc_statement_lines` had at migration 292. A
 * copy on purpose — the import's own definition keeps following the stored columns. Do not import
 * this from runtime code and do not update it.
 */
import crypto from "node:crypto";

const STATEMENT_FINGERPRINT_COLUMNS = [
  "card_group",
  "period_from",
  "period_to",
  "pay_by",
  "card_last4",
  "card_product",
  "layout",
  "currency",
  "saldo_anterior",
  "abono",
  "compras_cargos",
  "deuda_total",
  "monto_facturado",
  "monto_pagado_anterior",
  "monto_pagado_anterior_date",
  "next_period_from",
  "next_period_to",
] as const;

const LINE_FINGERPRINT_COLUMNS = [
  "transaction_date",
  "posting_date",
  "place",
  "merchant",
  "description_merged",
  "country",
  "amount_orig",
  "amount_clp",
  "amount_usd",
  "installment_flag",
  "nro_cuota_current",
  "nro_cuota_total",
  "valor_cuota_mensual_clp",
  "interest_rate_text",
  "tipo_cuota",
  "parser_row_id",
  "raw_line",
  "origin_card_last4",
] as const;

const canonicalValue = (v: unknown): string | number | null => (v == null ? null : typeof v === "number" ? v : String(v));

/** The fingerprint of a statement given as its stored columns. */
export function storedStatementFingerprint292(
  statement: Record<(typeof STATEMENT_FINGERPRINT_COLUMNS)[number], unknown>,
  lines: readonly Record<(typeof LINE_FINGERPRINT_COLUMNS)[number], unknown>[]
): string {
  const head = JSON.stringify(STATEMENT_FINGERPRINT_COLUMNS.map((c) => canonicalValue(statement[c])));
  const body = lines
    .map((line) => {
      const values = LINE_FINGERPRINT_COLUMNS.map((c) => canonicalValue(line[c]));
      const other = (line as { other_currency_amount?: unknown }).other_currency_amount;
      if (other != null) values.push(String(other));
      return JSON.stringify(values);
    })
    .sort();
  const h = crypto.createHash("sha256");
  h.update(head).update("\n");
  for (const line of body) h.update(line).update("\n");
  return h.digest("hex").slice(0, 32);
}
