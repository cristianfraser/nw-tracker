/**
 * Pieces of a card or checking purchase line (`cc_expense_line_splits`): what a cash withdrawal, or
 * any one charge, paid for — each piece with its own day, amount, category and note. The line keeps
 * what the pieces leave (`expandLineSplitsInDrafts`). A piece's purchase key is the line's plus
 * `#split:<seq>`, so a piece keeps its seq for life: its big group and note (what it was) hang off
 * that key. The table's own `note` column is provenance (`split:manual|…`) and is left as stored.
 */
import { getCcExpenseCategoryBySlug, isCcExpenseTotalsExcludedSlug } from "./ccExpenseCategories.js";
import { db } from "./db.js";
import { expenseLineDraftForPieces } from "./flowsExpenses.js";

export type ExpenseLinePieceSource = "cc" | "checking";

export type ExpenseLinePieceDto = {
  seq: number;
  /** The day it was spent; null = the line's own day. */
  spent_on: string | null;
  amount_clp: number;
  category_slug: string;
};

export type ExpenseLinePiecesDto = {
  source: ExpenseLinePieceSource;
  line_id: number;
  /** The line as it reads without pieces. */
  line_amount_clp: number;
  line_date: string;
  merchant: string;
  category_slug: string;
  pieces: ExpenseLinePieceDto[];
};

export type ExpenseLinePieceInput = {
  /** An existing piece's seq to keep its big group and note; absent for a new piece. */
  seq?: number | null;
  spent_on?: string | null;
  amount_clp: number;
  category_slug: string;
};

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function storedPieces(source: ExpenseLinePieceSource, lineId: number): ExpenseLinePieceDto[] {
  return db
    .prepare(
      `SELECT s.seq, s.spent_on, s.amount_clp, c.slug AS category_slug
       FROM cc_expense_line_splits s JOIN cc_expense_categories c ON c.id = s.category_id
       WHERE s.source = ? AND s.line_id = ? ORDER BY s.seq`
    )
    .all(source, lineId) as ExpenseLinePieceDto[];
}

export function getExpenseLinePieces(source: ExpenseLinePieceSource, lineId: number): ExpenseLinePiecesDto {
  const line = expenseLineDraftForPieces(source, lineId);
  return {
    source,
    line_id: lineId,
    line_amount_clp: line.amount_clp,
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
  const line = expenseLineDraftForPieces(source, lineId);
  const lineDate = line.purchase_on ?? line.occurred_on;
  const existing = storedPieces(source, lineId);
  const existingSeqs = new Set(existing.map((p) => p.seq));

  let total = 0;
  const keptSeqs = new Set<number>();
  for (const p of pieces) {
    if (!Number.isInteger(p.amount_clp) || p.amount_clp <= 0) {
      throw new Error(`piece amount must be a whole number of pesos above 0, got ${p.amount_clp}`);
    }
    total += p.amount_clp;
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
  if (total > line.amount_clp) {
    throw new Error(`pieces add up to ${total}, more than the line's ${line.amount_clp}`);
  }

  const categoryId = (slug: string) => getCcExpenseCategoryBySlug(slug)!.id;
  const accountId = line.account_id;
  const pieceKey = (seq: number) => `${line.purchase_key}#split:${seq}`;
  let nextSeq = Math.max(-1, ...existingSeqs) + 1;

  db.transaction(() => {
    for (const old of existing) {
      if (keptSeqs.has(old.seq)) continue;
      db.prepare(`DELETE FROM cc_expense_line_splits WHERE source = ? AND line_id = ? AND seq = ?`).run(
        source,
        lineId,
        old.seq
      );
      db.prepare(`DELETE FROM cc_expense_purchase_big_groups WHERE purchase_key = ?`).run(pieceKey(old.seq));
      db.prepare(`DELETE FROM cc_expense_purchase_notes WHERE account_id = ? AND purchase_key = ?`).run(
        accountId,
        pieceKey(old.seq)
      );
    }
    const upsert = db.prepare(
      `INSERT INTO cc_expense_line_splits (source, line_id, seq, category_id, amount_clp, spent_on)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(source, line_id, seq) DO UPDATE SET
         category_id = excluded.category_id,
         amount_clp = excluded.amount_clp,
         spent_on = excluded.spent_on`
    );
    for (const p of pieces) {
      const seq = p.seq ?? nextSeq++;
      upsert.run(source, lineId, seq, categoryId(p.category_slug), p.amount_clp, p.spent_on ? p.spent_on : null);
    }
  })();
  return getExpenseLinePieces(source, lineId);
}
