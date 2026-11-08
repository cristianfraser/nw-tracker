import { db } from "../db.js";

/**
 * Snapshot whole tables into memory so destructive test files can restore them in `afterAll`.
 * The shared file-based test DB is a copy of the dev DB — tests that `DELETE FROM fx_daily`
 * (or valuations/movements) without restoring poison every later test file in the run.
 *
 * Usage (module top level, before any hook runs):
 *   const restoreTables = snapshotTables(["fx_daily"]);
 *   afterAll(() => restoreTables());
 */
export function snapshotTables(tables: readonly string[]): () => void {
  const rowsByTable = new Map<string, Record<string, unknown>[]>();
  for (const table of tables) {
    if (!/^[A-Za-z0-9_]+$/.test(table)) {
      throw new Error(`snapshotTables: invalid table name ${table}`);
    }
    // Stored columns only: a generated column (`cc_statements.source_kind`) cannot be inserted.
    const columns = (db.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as { name: string }[])
      .map((c) => `"${c.name}"`)
      .join(", ");
    rowsByTable.set(table, db.prepare(`SELECT ${columns} FROM ${table}`).all() as Record<string, unknown>[]);
  }
  return () => {
    // Defer FK checks to commit: tables can be wiped/refilled in any order because the
    // committed end state is the (consistent) snapshot. Resets automatically at COMMIT.
    db.pragma("defer_foreign_keys = ON");
    db.transaction(() => {
      for (const [table] of rowsByTable) db.prepare(`DELETE FROM ${table}`).run();
      for (const [table, rows] of rowsByTable) {
        if (rows.length === 0) continue;
        // A row's flow (migration 279) went with the delete when nothing else named it: the
        // restored row gets a flow of its own from the insert trigger.
        const cols = Object.keys(rows[0]!).filter((c) => c !== '"flow_id"' && c !== "flow_id");
        const insert = db.prepare(
          `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map((c) => `@${c}`).join(", ")})`
        );
        for (const row of rows) insert.run(row);
      }
    })();
  };
}
