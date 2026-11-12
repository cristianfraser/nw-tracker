/**
 * Pieces of a card or checking purchase line (`flow_parts`, on the line's flow): what a cash withdrawal, or
 * any one charge, paid for — each piece with its own day, amount, category and note. A piece's amount
 * is in the line's own currency (its flow's: pesos, or a dollar line's dollars to the cent). The line keeps
 * what the pieces leave (`expandLineSplitsInDrafts`). A piece's purchase key is the line's plus
 * `#split:<seq>`, so a piece keeps its seq for life: its big group and note (what it was) hang off
 * that key. The table's own `note` column is provenance (`split:manual|…`) and is left as stored.
 */
import { deleteFlowNote } from "./flows/flowNotes.js";
import { getCcExpenseCategoryBySlug, isCcExpenseTotalsExcludedSlug } from "./ccExpenseCategories.js";
import { expensePieceKey } from "./expenseKeys.js";
import { db } from "./db.js";
import { currencyMinorDigits, roundToCurrency } from "./displayUnits.js";
import { lineMoneyFromBuilderFields } from "./lineMoney.js";
import { deleteKeyedRow } from "./flows/flowKeyedAssignments.js";
import { FLOW_PARTS_BY_LINE_SQL, lineFlowSql } from "./flows/flowParts.js";
import { expenseLineDraftForPieces } from "./flowsExpenses.js";

export type ExpenseLinePieceSource = "cc" | "checking";

export type ExpenseLinePieceDto = {
  seq: number;
  /** The day it was spent; null = the line's own day. */
  spent_on: string | null;
  /** In the line's currency. */
  amount: number;
  category_slug: string;
};

export type ExpenseLinePiecesDto = {
  source: ExpenseLinePieceSource;
  line_id: number;
  /** The line's own currency: its pieces' and `line_amount`'s. */
  currency: string;
  /** The line as it reads without pieces, in `currency`. */
  line_amount: number;
  line_date: string;
  merchant: string;
  category_slug: string;
  pieces: ExpenseLinePieceDto[];
};

export type ExpenseLinePieceInput = {
  /** An existing piece's seq to keep its big group and note; absent for a new piece. */
  seq?: number | null;
  spent_on?: string | null;
  /** In the line's currency, to its smallest coin. */
  amount: number;
  category_slug: string;
};

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function storedPieces(source: ExpenseLinePieceSource, lineId: number): ExpenseLinePieceDto[] {
  return db
    .prepare(
      `SELECT s.seq, s.spent_on, s.amount, c.slug AS category_slug
       FROM ${FLOW_PARTS_BY_LINE_SQL} s JOIN cc_expense_categories c ON c.id = s.category_id
       WHERE s.source = ? AND s.line_id = ? ORDER BY s.seq`
    )
    .all(source, lineId) as ExpenseLinePieceDto[];
}

/**
 * The line a set of pieces breaks down, with its own amount; throws when its flow is in another
 * currency than the line reads (the pieces are stored in the flow's).
 */
function pieceLine(source: ExpenseLinePieceSource, lineId: number) {
  const line = expenseLineDraftForPieces(source, lineId);
  const native = lineMoneyFromBuilderFields(line).amount;
  const flow = db.prepare(`SELECT currency FROM flows WHERE id = ${lineFlowSql(source)}`).get(lineId) as
    | { currency: string }
    | undefined;
  if (!flow) throw new Error(`${source} line ${lineId} has no flow`);
  if (flow.currency !== native.currency) {
    throw new Error(`${source} line ${lineId}: its flow is in ${flow.currency}, the line in ${native.currency}`);
  }
  return { line, native };
}

export function getExpenseLinePieces(source: ExpenseLinePieceSource, lineId: number): ExpenseLinePiecesDto {
  const { line, native } = pieceLine(source, lineId);
  return {
    source,
    line_id: lineId,
    currency: native.currency,
    line_amount: native.value,
    line_date: line.purchase_on ?? line.occurred_on,
    merchant: line.merchant ?? "",
    category_slug: line.category_slug,
    pieces: storedPieces(source, lineId),
  };
}

/**
 * Replaces a line's pieces with `pieces`. A piece naming an existing seq keeps it; a new one takes
 * the next seq never used on the line. A removed piece takes its big group and note with it.
 */
export function replaceExpenseLinePieces(
  source: ExpenseLinePieceSource,
  lineId: number,
  pieces: readonly ExpenseLinePieceInput[]
): ExpenseLinePiecesDto {
  const { line, native } = pieceLine(source, lineId);
  const lineDate = line.purchase_on ?? line.occurred_on;
  const existing = storedPieces(source, lineId);
  const existingSeqs = new Set(existing.map((p) => p.seq));

  let total = 0;
  const keptSeqs = new Set<number>();
  for (const p of pieces) {
    const amount = Number(p.amount);
    if (!Number.isFinite(amount) || amount <= 0 || roundToCurrency(amount, native.currency) !== amount) {
      throw new Error(
        `piece amount must be above 0 in ${native.currency}, to ${currencyMinorDigits(native.currency)} decimal(s), got ${p.amount}`
      );
    }
    total += amount;
    const category = getCcExpenseCategoryBySlug(p.category_slug);
    if (!category) throw new Error(`unknown category slug: ${p.category_slug}`);
    if (isCcExpenseTotalsExcludedSlug(p.category_slug)) {
      throw new Error(`a piece is spending; category not allowed: ${p.category_slug}`);
    }
    if (p.spent_on != null && p.spent_on !== "") {
      if (!ISO_DAY.test(p.spent_on)) throw new Error(`piece date must be YYYY-MM-DD, got ${p.spent_on}`);
      if (p.spent_on < lineDate) {
        throw new Error(`a piece cannot be spent (${p.spent_on}) before its line (${lineDate})`);
      }
    }
    if (p.seq != null) {
      if (!existingSeqs.has(p.seq)) throw new Error(`piece seq ${p.seq} is not on ${source}:${lineId}`);
      if (keptSeqs.has(p.seq)) throw new Error(`piece seq ${p.seq} given twice`);
      keptSeqs.add(p.seq);
    }
  }
  total = roundToCurrency(total, native.currency);
  if (total > native.value) {
    throw new Error(`pieces add up to ${total} ${native.currency}, more than the line's ${native.value}`);
  }

  const categoryId = (slug: string) => getCcExpenseCategoryBySlug(slug)!.id;
  const accountId = line.account_id;
  const pieceKey = (seq: number) => expensePieceKey(line.purchase_key, seq);
  let nextSeq = Math.max(-1, ...existingSeqs) + 1;

  db.transaction(() => {
    for (const old of existing) {
      if (keptSeqs.has(old.seq)) continue;
      db.prepare(`DELETE FROM flow_parts WHERE flow_id = ${lineFlowSql(source)} AND seq = ?`).run(lineId, old.seq);
      deleteKeyedRow("flow_big_groups", pieceKey(old.seq));
      deleteFlowNote(accountId, pieceKey(old.seq));
    }
    const upsert = db.prepare(
      `INSERT INTO flow_parts (flow_id, seq, kind, category_id, amount, spent_on)
       VALUES (${lineFlowSql(source)}, ?, 'piece', ?, ?, ?)
       ON CONFLICT(flow_id, seq) DO UPDATE SET
         category_id = excluded.category_id,
         amount = excluded.amount,
         spent_on = excluded.spent_on`
    );
    for (const p of pieces) {
      const seq = p.seq ?? nextSeq++;
      upsert.run(lineId, seq, categoryId(p.category_slug), Number(p.amount), p.spent_on ? p.spent_on : null);
    }
  })();
  return getExpenseLinePieces(source, lineId);
}
