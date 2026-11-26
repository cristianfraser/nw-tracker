import { EMPTY_CARD_STATEMENT_HEADER, parseDdMmYyToIso, type CardCanonicalLine, type CardCanonicalStatement } from "nw-tracker-contracts";
import { db } from "../db.js";
import { statementKeysOf } from "../ccInstallmentLedgerMerge.js";
import { replaceStatementLines } from "../cards/lineWrites.js";
import type { StatementDocumentsImportResult } from "../cards/statementLinePlanApply.js";

type StatementRow = {
  id: number;
  card_group: string;
  source_pdf: string;
  statement_date: string;
  period_from: string | null;
  period_to: string | null;
  pay_by: string | null;
  card_last4: string | null;
  card_product: string | null;
  layout: CardCanonicalStatement["layout"];
  currency: string;
  next_period_from: string | null;
  next_period_to: string | null;
};

type LineRow = {
  id: number;
  transaction_date: string | null;
  posting_date: string | null;
  merchant: string | null;
  amount: number;
  currency: string;
  installment_flag: number;
  nro_cuota_current: number | null;
  nro_cuota_total: number | null;
  cuota_amount: number | null;
  dedupe_key: string | null;
  parser_row_id: string | null;
};

/** A stored day (`d/m/yyyy`, `dd/mm/yyyy`, `dd/mm/yy`) as ISO; null for none. */
function isoOf(day: string | null): string | null {
  const t = String(day ?? "").trim();
  if (!t) return null;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(t);
  if (!m) throw new Error(`statementOnFile: day «${t}» does not read`);
  return parseDdMmYyToIso(`${m[1]!.padStart(2, "0")}/${m[2]!.padStart(2, "0")}/${m[3]}`);
}

function canonicalLine(r: LineRow): CardCanonicalLine {
  const id = r.parser_row_id ?? r.dedupe_key ?? `vitest-on-file:${r.id}`;
  const installment =
    r.installment_flag === 1
      ? {
          number: r.nro_cuota_current,
          count: r.nro_cuota_total,
          cuota_amount: r.cuota_amount,
          total_amount: null,
          interest_rate_text: null,
          cuota_type: null,
          plan_id: null,
        }
      : null;
  return {
    kind: installment ? "installment_cuota" : r.amount > 0 ? "card_purchase" : "card_refund",
    transaction_date: isoOf(r.transaction_date),
    posting_date: isoOf(r.posting_date),
    printed_transaction_date: null,
    printed_posting_date: null,
    merchant: r.merchant,
    description: null,
    place: null,
    country: null,
    currency: r.currency,
    amount: r.amount,
    origin_amount: null,
    installment,
    origin_card_last4: null,
    cuota_purchase: null,
    document: { line_id: id, dedupe_key: r.dedupe_key ?? id, section: "compact", raw_text: r.merchant ?? "", duplicate_across_statements: false, baseline_match: null },
  } as CardCanonicalLine;
}

/**
 * A statement a test wrote row by row, imported the way its document arrives: its `cc_statements`
 * row and lines are read back into a canonical statement, deleted, and imported through the
 * statement import (`replaceStatementLines`), which settles the open bucket against it. `lineId`
 * maps a line id the test wrote to the id the import gave the same document line.
 */
export function importStatementOnFile(
  accountId: number,
  statementIds: readonly number[]
): { result: StatementDocumentsImportResult; lineId: (writtenId: number) => number } {
  const parserRowOf = new Map<number, string>();
  const statements = statementIds.map((id) => {
    const st = db
      .prepare(
        `SELECT id, card_group, source_pdf, statement_date, period_from, period_to, pay_by, card_last4, card_product, layout, currency,
                next_period_from, next_period_to
         FROM cc_statements WHERE id = ? AND account_id = ?`
      )
      .get(id, accountId) as StatementRow | undefined;
    if (!st) throw new Error(`statementOnFile: no statement ${id} on account ${accountId}`);
    const lines = (
      db
        .prepare(
          `SELECT id, transaction_date, posting_date, merchant, amount, currency, installment_flag, nro_cuota_current, nro_cuota_total,
                  cuota_amount, dedupe_key, parser_row_id
           FROM cc_statement_lines WHERE statement_id = ? ORDER BY id`
        )
        .all(id) as LineRow[]
    ).map((r) => {
      const line = canonicalLine(r);
      parserRowOf.set(r.id, line.document.line_id!);
      return line;
    });
    const statement: CardCanonicalStatement = {
      document: st.source_pdf,
      card_group: st.card_group,
      close: st.statement_date,
      period_from: st.period_from,
      period_to: st.period_to,
      pay_by: st.pay_by,
      card_last4: st.card_last4,
      card_product: st.card_product,
      currency: st.currency,
      layout: st.layout,
      // The printed following cycle only: the totals a test writes are not the reconcile gate's.
      header: { ...EMPTY_CARD_STATEMENT_HEADER, next_period_from: st.next_period_from, next_period_to: st.next_period_to },
      lines,
    };
    return statement;
  });
  db.prepare(`DELETE FROM cc_statements WHERE id IN (${statementIds.map(() => "?").join(",")})`).run(...statementIds);
  const result = replaceStatementLines(accountId, statements, { replaceStatementKeys: statementKeysOf(statements) });
  const byParserRow = db.prepare(
    `SELECT l.id FROM cc_statement_lines l JOIN cc_statements s ON s.id = l.statement_id WHERE s.account_id = ? AND l.parser_row_id = ?`
  );
  return {
    result,
    lineId: (writtenId) => {
      const prid = parserRowOf.get(writtenId);
      if (prid == null) throw new Error(`statementOnFile: line ${writtenId} was not on an imported statement`);
      const row = byParserRow.get(accountId, prid) as { id: number } | undefined;
      if (!row) throw new Error(`statementOnFile: line ${writtenId} (${prid}) was not written`);
      return row.id;
    },
  };
}

/** Statement documents imported as the corpus import runs them: each restates its stored copy. */
export function importStatementDocumentsReplacing(accountId: number, statements: CardCanonicalStatement[]): StatementDocumentsImportResult {
  return replaceStatementLines(accountId, statements, { replaceStatementKeys: statementKeysOf(statements) });
}
