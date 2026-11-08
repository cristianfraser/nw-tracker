import type { Database as DatabaseType } from "better-sqlite3";
import { writeLogTriggerSql } from "../markInputTriggers.js";
import { expenseKeySql } from "../expenseKeys.js";
import { expenseKeyParts } from "./flowKeyResolve.js";

/**
 * Hooks of the assignment migrations (280+, docs/untangle-flow-identity.md F9 step 3): each moves
 * one table onto `flows`, reports old → new counts (no amounts), proves every old row became exactly
 * one new row, archives the rows whose key names nothing (`flow_orphan_assignments`), installs the
 * new table's write log and drops the old table. Pure: no `db` import.
 */

function installWriteLog(dbi: DatabaseType, table: string): void {
  const columns = (dbi.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as { name: string }[]).map((c) => c.name);
  for (const sql of writeLogTriggerSql(table, columns, null)) dbi.exec(sql);
}

function count(dbi: DatabaseType, table: string): number {
  return (dbi.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
}

/**
 * A movement-keyed table onto the movement's flow. Each flow must be the flow of that one movement
 * (a flow shared by two movements would carry the mark onto both).
 */
function moveMovementKeyed(dbi: DatabaseType, migration: string, from: string, to: string, columns: readonly string[]): void {
  const before = count(dbi, from);
  const shared = dbi
    .prepare(
      `SELECT o.movement_id FROM ${from} o JOIN movements m ON m.id = o.movement_id
       WHERE m.flow_id IS NULL OR (SELECT COUNT(*) FROM movements x WHERE x.flow_id = m.flow_id) <> 1 LIMIT 5`
    )
    .all() as { movement_id: number }[];
  if (shared.length > 0) {
    throw new Error(`migration ${migration}: movements whose flow is not their own: ${shared.map((s) => s.movement_id).join(", ")}`);
  }
  const missing = dbi
    .prepare(`SELECT o.movement_id FROM ${from} o LEFT JOIN movements m ON m.id = o.movement_id WHERE m.id IS NULL LIMIT 5`)
    .all() as { movement_id: number }[];
  if (missing.length > 0) {
    throw new Error(`migration ${migration}: ${from} rows on missing movements: ${missing.map((s) => s.movement_id).join(", ")}`);
  }
  dbi.exec(
    `INSERT INTO ${to} (flow_id, ${columns.join(", ")})
     SELECT m.flow_id, ${columns.map((c) => `o.${c}`).join(", ")} FROM ${from} o JOIN movements m ON m.id = o.movement_id`
  );
  const after = count(dbi, to);
  console.log(`migration ${migration}: ${from} ${before} → ${to} ${after}`);
  if (after !== before) throw new Error(`migration ${migration}: ${before} rows became ${after}`);
  const differ = dbi
    .prepare(
      `SELECT COUNT(*) AS c FROM ${from} o JOIN movements m ON m.id = o.movement_id
       LEFT JOIN ${to} n ON n.flow_id = m.flow_id
       WHERE n.flow_id IS NULL OR ${columns.map((c) => `n.${c} IS NOT o.${c}`).join(" OR ")}`
    )
    .get() as { c: number };
  if (differ.c > 0) throw new Error(`migration ${migration}: ${differ.c} row(s) differ after the move`);
  dbi.exec(`DROP TABLE ${from}`);
  installWriteLog(dbi, to);
}

export function runFlowRefunds280(dbi: DatabaseType): void {
  moveMovementKeyed(dbi, "280", "checking_expense_refunds", "flow_refunds", ["category_id", "created_at"]);
}

export function runFlowIncomeOverrides281(dbi: DatabaseType): void {
  moveMovementKeyed(dbi, "281", "checking_income_movement_overrides", "flow_income_overrides", [
    "is_excluded",
    "income_kind",
    "note",
    "updated_at",
    "force_include",
  ]);
}

/**
 * A key-named table onto the flows: each row goes to the flow that answers to its key's flow key
 * (migration 279 made one for every key that names a row), with the key's portion and piece; a row
 * whose key names nothing is archived as it was (`flow_orphan_assignments`). Proves old = moved +
 * archived, and that every moved row reads back under its old key with its old values.
 */
export function moveKeyedTable(
  dbi: DatabaseType,
  migration: string,
  from: string,
  to: string,
  keyColumn: string,
  columns: readonly string[]
): { moved: number; archived: number } {
  const before = count(dbi, from);
  const rows = dbi.prepare(`SELECT rowid AS _rowid, * FROM ${from}`).all() as Record<string, unknown>[];
  const flowOf = dbi.prepare(`SELECT id FROM flows WHERE legacy_key = ?`);
  const insert = dbi.prepare(
    `INSERT INTO ${to} (flow_id, portion, piece_seq${columns.map((c) => `, ${c}`).join("")})
     VALUES (?, ?, ?${columns.map(() => ", ?").join("")})`
  );
  const archive = dbi.prepare(`INSERT INTO flow_orphan_assignments (source_table, purchase_key, payload) VALUES (?, ?, ?)`);
  let moved = 0;
  let archived = 0;
  for (const r of rows) {
    const key = String(r[keyColumn]);
    const parts = expenseKeyParts(key);
    if (!parts) throw new Error(`migration ${migration}: ${from} holds «${key}», which is not an expense key`);
    const flow = flowOf.get(parts.flowKey) as { id: number } | undefined;
    const { _rowid, ...payload } = r;
    void _rowid;
    if (!flow) {
      archive.run(from, key, JSON.stringify(payload));
      archived += 1;
      continue;
    }
    insert.run(flow.id, parts.portion, parts.pieceSeq ?? -1, ...columns.map((c) => r[c] as string | number | null));
    moved += 1;
  }
  const after = count(dbi, to);
  console.log(`migration ${migration}: ${from} ${before} → ${to} ${after} + ${archived} archived (key names no row)`);
  if (after !== moved || moved + archived !== before) {
    throw new Error(`migration ${migration}: ${before} rows became ${after} + ${archived} archived`);
  }
  // Read back under the old keys.
  const keySql = expenseKeySql("f.legacy_key", "n.portion", "NULLIF(n.piece_seq, -1)");
  const readBack = new Map<string, string>();
  for (const n of dbi
    .prepare(`SELECT ${keySql} AS k, ${columns.map((c) => `n.${c}`).join(", ")} FROM ${to} n JOIN flows f ON f.id = n.flow_id`)
    .all() as Record<string, unknown>[]) {
    readBack.set(`${n.k}|${columns.map((c) => JSON.stringify(n[c])).join("|")}`, "");
  }
  for (const r of rows) {
    const key = String(r[keyColumn]);
    if (!dbi.prepare(`SELECT 1 FROM flows WHERE legacy_key = ?`).get(expenseKeyParts(key)!.flowKey)) continue;
    const sig = `${key}|${columns.map((c) => JSON.stringify(r[c])).join("|")}`;
    if (!readBack.has(sig)) throw new Error(`migration ${migration}: «${key}» does not read back after the move`);
  }
  dbi.exec(`DROP TABLE ${from}`);
  installWriteLog(dbi, to);
  return { moved, archived };
}

export function runFlowBigGroups282(dbi: DatabaseType): void {
  moveKeyedTable(dbi, "282", "cc_expense_purchase_big_groups", "flow_big_groups", "purchase_key", ["group_slug"]);
}
