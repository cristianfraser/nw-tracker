import { db } from "./db.js";
import { FLOW_PARTS_BY_LINE_SQL } from "./flows/flowParts.js";

export type CcExpenseLineSplit = {
  source: "cc" | "checking";
  line_id: number;
  seq: number;
  category_slug: string;
  /** In `currency`, the currency of the line's flow (a piece of a dollar line is dollars). */
  amount: number;
  currency: string;
  note: string | null;
  /** The day the piece was spent; null = the line's own day. */
  spent_on: string | null;
};

/**
 * Load ALL line splits keyed by `${source}:${line_id}` — excel-gap reconstruction
 * splits and manual splits alike (e.g. one bank transfer covering two months'
 * gastos comunes, note `split:manual|…`). The note records provenance only.
 */
export function loadCcExpenseLineSplits(): Map<string, CcExpenseLineSplit[]> {
  const rows = db
    .prepare(
      `SELECT s.source, s.line_id, s.seq, c.slug AS category_slug, s.amount, s.currency, s.note, s.spent_on
       FROM ${FLOW_PARTS_BY_LINE_SQL} s
       JOIN cc_expense_categories c ON c.id = s.category_id
       ORDER BY s.source, s.line_id, s.seq`
    )
    .all() as {
    source: string;
    line_id: number;
    seq: number;
    category_slug: string;
    amount: number;
    currency: string;
    note: string | null;
    spent_on: string | null;
  }[];

  const map = new Map<string, CcExpenseLineSplit[]>();
  for (const row of rows) {
    const key = `${row.source}:${row.line_id}`;
    const arr = map.get(key) ?? [];
    arr.push({
      source: row.source as "cc" | "checking",
      line_id: row.line_id,
      seq: row.seq,
      category_slug: row.category_slug,
      amount: row.amount,
      currency: row.currency,
      note: row.note,
      spent_on: row.spent_on,
    });
    map.set(key, arr);
  }
  return map;
}

