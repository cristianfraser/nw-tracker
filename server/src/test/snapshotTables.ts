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
  const flowSourceTables = new Set<string>();
  for (const table of tables) {
    if (!/^[A-Za-z0-9_]+$/.test(table)) {
      throw new Error(`snapshotTables: invalid table name ${table}`);
    }
    // Stored columns only: a generated column (`cc_statements.source_kind`) cannot be inserted.
    const columns = (db.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as { name: string }[])
      .map((c) => `"${c.name}"`)
      .join(", ");
    rowsByTable.set(table, db.prepare(`SELECT ${columns} FROM ${table}`).all() as Record<string, unknown>[]);
    // A flow SOURCE table (migration 279: `cc_statement_lines`, `movements`, …) has an insert
    // trigger that gives a row its flow; a flow-KEYED table (`flow_notes`) has none — its
    // `flow_id` is the row's identity and must be restored as stored.
    if (db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = ?`).get(`flow_${table}_ai`)) {
      flowSourceTables.add(table);
    }
  }
  return () => {
    // Defer FK checks to commit: tables can be wiped/refilled in any order because the
    // committed end state is the (consistent) snapshot. Resets automatically at COMMIT.
    db.pragma("defer_foreign_keys = ON");
    db.transaction(() => {
      for (const [table] of rowsByTable) db.prepare(`DELETE FROM ${table}`).run();
      for (const [table, rows] of rowsByTable) {
        if (rows.length === 0) continue;
        // A source row's flow went with the delete when nothing else named it: the restored row
        // gets a flow of its own from the insert trigger. A keyed row keeps the flow it names
        // (a flow with a legacy key outlives its rows, so the reference still holds).
        const stripFlow = flowSourceTables.has(table);
        const cols = Object.keys(rows[0]!).filter((c) => !stripFlow || (c !== '"flow_id"' && c !== "flow_id"));
        const insert = db.prepare(
          `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map((c) => `@${c}`).join(", ")})`
        );
        for (const row of rows) insert.run(row);
      }
    })();
  };
}
