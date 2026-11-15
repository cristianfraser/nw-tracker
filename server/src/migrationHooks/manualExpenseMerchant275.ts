import type { Database as DatabaseType } from "better-sqlite3";

/**
 * Migration 275 hook: a manual expense's `merchant` from its note, read once the way the Expenses
 * page read it (the note without its `manual:` prefix, trimmed; empty = none, the line then shows
 * its category). Only generic manual rows (no place); a place's bill is named by its place. Frozen:
 * the runtime reads the column.
 */
export function runManualExpenseMerchant275(dbi: DatabaseType): void {
  const rows = dbi
    .prepare(`SELECT id, note FROM expense_entries WHERE expense_account_id IS NULL AND category IS NOT NULL`)
    .all() as { id: number; note: string | null }[];
  const set = dbi.prepare(`UPDATE expense_entries SET merchant = ? WHERE id = ?`);
  let filled = 0;
  let empty = 0;
  for (const r of rows) {
    const merchant = String(r.note ?? "").replace(/^manual:/, "").trim();
    if (!merchant) {
      empty += 1;
      continue;
    }
    set.run(merchant, r.id);
    filled += 1;
  }
  console.log(`migration 275 manual expense merchant: ${JSON.stringify({ rows: rows.length, filled, empty })}`);
}
