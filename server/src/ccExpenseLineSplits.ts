import { db } from "./db.js";

export const EXCEL_GAP_SPLIT_NOTE_PREFIX = "split:excel-gap|";

export type CcExpenseLineSplit = {
  source: "cc" | "checking";
  line_id: number;
  seq: number;
  category_slug: string;
  amount_clp: number;
  note: string | null;
};

/**
 * Load ALL line splits keyed by `${source}:${line_id}` — excel-gap reconstruction
 * splits and manual splits alike (e.g. one bank transfer covering two months'
 * gastos comunes, note `split:manual|…`). The note records provenance only.
 */
export function loadCcExpenseLineSplits(): Map<string, CcExpenseLineSplit[]> {
  const rows = db
    .prepare(
      `SELECT s.source, s.line_id, s.seq, c.slug AS category_slug, s.amount_clp, s.note
       FROM cc_expense_line_splits s
       JOIN cc_expense_categories c ON c.id = s.category_id
       ORDER BY s.source, s.line_id, s.seq`
    )
    .all() as {
    source: string;
    line_id: number;
    seq: number;
    category_slug: string;
    amount_clp: number;
    note: string | null;
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
      amount_clp: row.amount_clp,
      note: row.note,
    });
    map.set(key, arr);
  }
  return map;
}

export function insertLineSplits(opts: {
  source: "cc" | "checking";
  lineId: number;
  splits: Array<{ categorySlug: string; amountClp: number; note: string }>;
  lineAmountClp: number;
}): void {
  const sum = opts.splits.reduce((s, p) => s + p.amountClp, 0);
  if (Math.abs(sum - opts.lineAmountClp) > 1) {
    throw new Error(
      `cc_expense_line_splits sum (${sum}) ≠ line amount (${opts.lineAmountClp}) for ${opts.source}:${opts.lineId}`
    );
  }

  const getCatId = db.prepare(`SELECT id FROM cc_expense_categories WHERE slug = ? LIMIT 1`);
  const ins = db.prepare(
    `INSERT INTO cc_expense_line_splits (source, line_id, seq, category_id, amount_clp, note)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(source, line_id, seq) DO UPDATE SET
       category_id = excluded.category_id,
       amount_clp  = excluded.amount_clp,
       note        = excluded.note`
  );

  const tx = db.transaction(() => {
    for (let i = 0; i < opts.splits.length; i++) {
      const part = opts.splits[i]!;
      const catRow = getCatId.get(part.categorySlug) as { id: number } | undefined;
      if (!catRow) throw new Error(`unknown category slug: ${part.categorySlug}`);
      ins.run(opts.source, opts.lineId, i, catRow.id, part.amountClp, part.note);
    }
  });
  tx();
}

/** Delete all excel-gap splits. Returns rows deleted. */
export function deleteAllExcelGapSplits(): number {
  return db
    .prepare(`DELETE FROM cc_expense_line_splits WHERE note LIKE ?`)
    .run(`${EXCEL_GAP_SPLIT_NOTE_PREFIX}%`).changes;
}

/** Count excel-gap splits (for dry-run reporting). */
export function countExcelGapSplits(): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM cc_expense_line_splits WHERE note LIKE ?`)
    .get(`${EXCEL_GAP_SPLIT_NOTE_PREFIX}%`) as { n: number };
  return row.n;
}
