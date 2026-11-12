import { parseDdMmYyToIso } from "../formats/dates.js";
import { parseChileanNumber, parseOptionalChileanInteger } from "../formats/numbers.js";
import type { CardParsedStatementsPayload } from "../kinds/cardParsedStatements.js";
import {
  cardStatementKey,
  cardStatementLayout,
  type CardCanonicalLine,
  type CardCanonicalStatement,
  type CardCanonicalStatementHeader,
} from "./canonicalLine.js";
import { cardLineKind } from "./lineRules.js";

/**
 * The card statement parser's rows (`cc-statements-parsed-all.csv`, `card.parsed_statements`) →
 * canonical statements: the one place the parser's printed cells become numbers, days and a kind.
 * Ingest converts before sending; the server converts a `card.parsed_statements` it still receives
 * with this same function.
 *
 * The parser prints Chilean numbers (`13,77`, `1.234,56`, plain integers): that is the one number
 * style read here. Rows are grouped into statements by `card_group` + `source_pdf` +
 * `statement_date`, in the order the rows first name them, lines in row order (the order decides
 * which of two same-statement twins is `#dup1`). A statement whose rows disagree on a
 * statement-level field, a line with no amount or both amounts, or a line that already carries an
 * origin currency (labeled on import, never by the parser) throws.
 */

type Row = Record<string, string>;

const cell = (row: Row, column: string): string => String(row[column] ?? "").trim();
const textOrNull = (row: Row, column: string): string | null => cell(row, column) || null;

function numberOrNull(row: Row, column: string): number | null {
  const t = cell(row, column);
  return t ? parseChileanNumber(t) : null;
}

/** A `DD/MM/YYYY` cell zero-padded, or null when empty; any other shape throws. */
function ddMmYyyyOrNull(raw: string): string | null {
  const t = raw.trim();
  if (!t) return null;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t);
  if (!m) throw new Error(`Unexpected statement date "${t}" (want DD/MM/YYYY)`);
  return `${m[1]!.padStart(2, "0")}/${m[2]!.padStart(2, "0")}/${m[3]}`;
}

/** The statement-level columns every row of one statement repeats. */
const STATEMENT_COLUMNS = [
  "period_from",
  "period_to",
  "pay_by",
  "card_last4",
  "card_product",
  "currency",
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

function rowCurrency(row: Row): "clp" | "usd" {
  if (cell(row, "currency").toLowerCase() === "usd") return "usd";
  return cell(row, "parser_layout") === "international_usd" ? "usd" : "clp";
}

function headerFromRow(row: Row): CardCanonicalStatementHeader {
  const paidOn = cell(row, "statement_monto_pagado_anterior_date");
  return {
    saldo_anterior: numberOrNull(row, "statement_saldo_anterior"),
    abono: numberOrNull(row, "statement_abono"),
    compras_cargos: numberOrNull(row, "statement_compras_cargos"),
    deuda_total: numberOrNull(row, "statement_deuda_total"),
    monto_facturado: numberOrNull(row, "statement_monto_facturado"),
    monto_facturado_anterior: numberOrNull(row, "statement_monto_facturado_anterior"),
    monto_pagado_anterior: numberOrNull(row, "statement_monto_pagado_anterior"),
    monto_pagado_anterior_date: /^\d{4}-\d{2}-\d{2}$/.test(paidOn) ? paidOn : null,
    next_period_from: ddMmYyyyOrNull(cell(row, "statement_next_period_from")),
    next_period_to: ddMmYyyyOrNull(cell(row, "statement_next_period_to")),
    pdf_total_operaciones: numberOrNull(row, "pdf_total_operaciones"),
  };
}

/** One parser row → the canonical line, on a statement in `statementCurrency`. */
export function canonicalLineFromParsedRow(row: Row, statementCurrency: string): CardCanonicalLine {
  const document = cell(row, "source_pdf");
  if (cell(row, "orig_currency")) {
    throw new Error(
      `CC statement import (${document}): line «${cell(row, "merchant")}» carries orig_currency "${cell(row, "orig_currency")}", ` +
        `but origins are labeled on import — re-run parse:cc-pdfs`
    );
  }
  const clp = parseOptionalChileanInteger(cell(row, "amount_clp"));
  const usd = numberOrNull(row, "amount_usd");
  if ((clp == null) === (usd == null)) {
    throw new Error(`CC statement import (${document}): line «${cell(row, "merchant")}» must carry exactly one of amount_clp / amount_usd`);
  }
  const installment = cell(row, "installment_flag").toLowerCase() === "true";
  const merchant = cell(row, "merchant");
  const origen = parseOptionalChileanInteger(cell(row, "monto_origen_operacion_clp"));
  const total = parseOptionalChileanInteger(cell(row, "monto_total_a_pagar_clp"));
  const printedTx = textOrNull(row, "transaction_date");
  const printedPost = textOrNull(row, "posting_date");
  return {
    kind: cardLineKind({
      installment_flag: installment,
      merchant: merchant || null,
      amount_clp: clp ?? 0,
      amount_usd: usd,
      statement_currency: statementCurrency,
    }),
    transaction_date: printedTx ? parseDdMmYyToIso(printedTx) : null,
    posting_date: printedPost ? parseDdMmYyToIso(printedPost) : null,
    printed_transaction_date: printedTx,
    printed_posting_date: printedPost,
    merchant,
    description: textOrNull(row, "description_merged"),
    place: textOrNull(row, "place"),
    country: textOrNull(row, "country"),
    currency: clp != null ? "clp" : "usd",
    amount: clp ?? usd!,
    origin_amount: numberOrNull(row, "amount_orig"),
    installment: installment
      ? {
          number: parseOptionalChileanInteger(cell(row, "nro_cuota_current")),
          count: parseOptionalChileanInteger(cell(row, "nro_cuota_total")),
          cuota_amount: parseOptionalChileanInteger(cell(row, "valor_cuota_mensual_clp")),
          total_amount: origen == null && total == null ? null : Math.max(origen ?? 0, total ?? 0),
          interest_rate_text: textOrNull(row, "interest_rate_text"),
          cuota_type: textOrNull(row, "tipo_cuota"),
          plan_id: textOrNull(row, "canonical_row_id"),
        }
      : null,
    origin_card_last4: textOrNull(row, "origin_card_last4"),
    cuota_purchase: null,
    document: {
      line_id: textOrNull(row, "row_id"),
      dedupe_key: textOrNull(row, "dedupe_key"),
      section: cell(row, "parser_layout"),
      raw_text: textOrNull(row, "raw_line"),
      duplicate_across_statements: cell(row, "is_duplicate_across_statements").toLowerCase() === "true",
      baseline_match: textOrNull(row, "matched_excel_row"),
    },
  };
}

/** Parser rows, as records keyed by column → canonical statements (see the module comment). */
export function canonicalStatementsFromParsedRecords(records: readonly Row[]): CardCanonicalStatement[] {
  const byKey = new Map<string, { statement: CardCanonicalStatement; signature: string }>();
  for (const row of records) {
    const first = {
      document: cell(row, "source_pdf"),
      card_group: cell(row, "card_group"),
      close: cell(row, "statement_date"),
    };
    const key = cardStatementKey(first);
    const signature = STATEMENT_COLUMNS.map((c) => cell(row, c)).join("\u0001");
    let entry = byKey.get(key);
    if (!entry) {
      if (!first.document) throw new Error("CC statement import: a parsed line names no source_pdf");
      const currency = rowCurrency(row);
      entry = {
        signature,
        statement: {
          ...first,
          period_from: textOrNull(row, "period_from"),
          period_to: textOrNull(row, "period_to"),
          pay_by: textOrNull(row, "pay_by"),
          card_last4: textOrNull(row, "card_last4"),
          card_product: textOrNull(row, "card_product"),
          currency,
          layout: cardStatementLayout(cell(row, "parser_layout")),
          header: headerFromRow(row),
          lines: [],
        },
      };
      byKey.set(key, entry);
    } else if (entry.signature !== signature) {
      throw new Error(`CC statement import (${first.document}): its lines disagree on the statement's own fields`);
    }
    entry.statement.lines.push(canonicalLineFromParsedRow(row, entry.statement.currency));
  }
  return [...byKey.values()].map((e) => e.statement);
}

/** A `card.parsed_statements` payload (columns once, then each line's values) → canonical statements. */
export function canonicalStatementsFromParsedPayload(
  payload: Pick<CardParsedStatementsPayload, "columns" | "rows">
): CardCanonicalStatement[] {
  return canonicalStatementsFromParsedRecords(
    payload.rows.map((values) => Object.fromEntries(payload.columns.map((c, i) => [c, values[i] ?? ""])))
  );
}
