/**
 * How a canonical card statement is stored (`cc_statements`, `cc_statement_lines`), and its import
 * fingerprint. A leaf (no database): the import writes these columns, and migration 292 re-derives
 * every stored statement's fingerprint from the same columns read back.
 *
 * **The fingerprint** (`import_fingerprint`) lets the incremental import skip a statement whose
 * content is what was imported last time: a hash of the statement's stored columns and of each of
 * its lines' stored columns — what the ledger keeps of the document, not the bytes a source
 * printed, so two renderings of the same statement (a number written «13,77» or «13.77», a
 * re-downloaded PDF under another file name) hash alike. The statement's identity columns (its
 * document name and close: the row the import resolves it to) and the columns the import derives
 * (the line kind, the origin-currency label, the dedupe keys, ids) stay out, and so do the lines
 * the import drops as repeats within the statement. A statement whose import skipped a line as a
 * duplicate of a line on ANOTHER statement hashes differently from its stored lines; the import
 * writes the incoming statement's hash, so only the migration's re-derivation can disagree, and
 * such a statement re-imports once.
 */
import crypto from "node:crypto";
import { storedCardLineDate, type CardCanonicalLine, type CardCanonicalStatement } from "nw-tracker-contracts";
import { ccCardGroupOrDefault } from "../ccIssuers.js";
import { canonicalCcLineDedupeKeys } from "../ccDedupeKey.js";

/** The line's pesos and dollars as the ledger stores them (`amount_clp` 0, `amount_usd` null when absent). */
export function storedCardLineAmounts(line: Pick<CardCanonicalLine, "currency" | "amount">): {
  amount_clp: number;
  amount_usd: number | null;
} {
  return line.currency === "clp" ? { amount_clp: line.amount, amount_usd: null } : { amount_clp: 0, amount_usd: line.amount };
}

/** The ledger's `cc_statements` columns of a canonical statement (header totals as stored). */
export function storedStatementColumns(statement: CardCanonicalStatement) {
  const h = statement.header;
  return {
    card_group: ccCardGroupOrDefault(statement.card_group),
    source_pdf: statement.document.trim(),
    statement_date: statement.close.trim(),
    period_from: statement.period_from,
    period_to: statement.period_to,
    pay_by: statement.pay_by,
    card_last4: statement.card_last4,
    card_product: statement.card_product,
    layout: statement.layout,
    currency: statement.currency,
    // An empty header cell (a total the statement does not print) stores 0, monto_facturado null
    // (as printed, whatever the sign: a period that ended in credit bills a negative amount, one
    // with nothing to pay 0 — `statementHeaderFacturado`).
    saldo_anterior: h.saldo_anterior ?? 0,
    abono: h.abono ?? 0,
    compras_cargos: h.compras_cargos ?? 0,
    deuda_total: h.deuda_total ?? 0,
    monto_facturado: h.monto_facturado,
    monto_pagado_anterior: h.monto_pagado_anterior ?? 0,
    monto_pagado_anterior_date: h.monto_pagado_anterior_date,
    // The printed following cycle (`ccBillingCloses.ts`), DD/MM/YYYY like period_from/to.
    next_period_from: h.next_period_from,
    next_period_to: h.next_period_to,
  };
}

/** The ledger's `cc_statement_lines` columns of a canonical line (dedupe key and ids apart). */
export function storedLineColumns(statement: CardCanonicalStatement, line: CardCanonicalLine) {
  const inst = line.installment;
  const { amount_clp, amount_usd } = storedCardLineAmounts(line);
  return {
    transaction_date: storedCardLineDate(line.printed_transaction_date, line.transaction_date),
    posting_date: storedCardLineDate(line.printed_posting_date, line.posting_date),
    place: line.place,
    merchant: line.merchant || null,
    description_merged: line.description,
    country: line.country,
    amount_orig: line.origin_amount,
    amount_clp,
    amount_usd,
    installment_flag: inst ? 1 : 0,
    nro_cuota_current: inst?.number ?? 0,
    nro_cuota_total: inst?.count ?? 0,
    valor_cuota_mensual_clp: inst?.cuota_amount ?? 0,
    interest_rate_text: inst?.interest_rate_text ?? null,
    tipo_cuota: inst?.cuota_type ?? null,
    parser_row_id: line.document.line_id,
    raw_line: line.document.raw_text,
    origin_card_last4: line.origin_card_last4 ?? statement.card_last4,
  };
}

/** The line's import dedupe keys (the document's, plus the one-shot key). */
export function canonicalLineDedupeKeys(cardGroup: string, line: CardCanonicalLine): string[] {
  return canonicalCcLineDedupeKeys(cardGroup, {
    installment: line.installment != null,
    dateIso: line.transaction_date ?? line.posting_date,
    merchant: line.merchant,
    amountClp: storedCardLineAmounts(line).amount_clp,
    documentKey: line.document.dedupe_key,
  });
}

/**
 * The statement's lines less those the import drops as repeats of an earlier line of the same
 * statement (every one of its dedupe keys already taken: the parser printed the same line twice).
 * A colliding computed key with a fresh document key is a same-statement twin and stays — the
 * import suffixes it `#dupN`, and the suffixed key is what later lines collide with.
 */
export function statementLinesLessRepeats(statement: CardCanonicalStatement): CardCanonicalLine[] {
  const cardGroup = ccCardGroupOrDefault(statement.card_group);
  const seen = new Set<string>();
  const kept: CardCanonicalLine[] = [];
  for (const line of statement.lines) {
    const keys = canonicalLineDedupeKeys(cardGroup, line);
    if (keys.length > 0 && keys.every((k) => seen.has(k))) continue;
    for (const k of keys) {
      let key = k;
      if (seen.has(key)) {
        let n = 1;
        while (seen.has(`${k}#dup${n}`)) n += 1;
        key = `${k}#dup${n}`;
      }
      seen.add(key);
    }
    kept.push(line);
  }
  return kept;
}

/** The stored columns the fingerprint hashes, per statement and per line (see the module comment). */
export type StoredStatementForFingerprint = Omit<ReturnType<typeof storedStatementColumns>, "source_pdf" | "statement_date">;
export type StoredLineForFingerprint = ReturnType<typeof storedLineColumns>;

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
] as const satisfies readonly (keyof StoredStatementForFingerprint)[];

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
] as const satisfies readonly (keyof StoredLineForFingerprint)[];

const canonicalValue = (v: unknown): string | number | null => (v == null ? null : typeof v === "number" ? v : String(v));

/** The fingerprint of a statement given as its stored columns (the import's and migration 292's). */
export function storedStatementFingerprint(
  statement: Record<(typeof STATEMENT_FINGERPRINT_COLUMNS)[number], unknown>,
  lines: readonly Record<(typeof LINE_FINGERPRINT_COLUMNS)[number], unknown>[]
): string {
  const head = JSON.stringify(STATEMENT_FINGERPRINT_COLUMNS.map((c) => canonicalValue(statement[c])));
  const body = lines.map((line) => JSON.stringify(LINE_FINGERPRINT_COLUMNS.map((c) => canonicalValue(line[c])))).sort();
  const h = crypto.createHash("sha256");
  h.update(head).update("\n");
  for (const line of body) h.update(line).update("\n");
  return h.digest("hex").slice(0, 32);
}

/**
 * A canonical statement's fingerprint: its lines as the import would store them, less the repeats
 * it drops ({@link statementLinesLessRepeats}).
 */
export function cardStatementFingerprint(statement: CardCanonicalStatement): string {
  return storedStatementFingerprint(
    storedStatementColumns(statement),
    statementLinesLessRepeats(statement).map((line) => storedLineColumns(statement, line))
  );
}
