import type { Database as DatabaseType } from "better-sqlite3";
import { writeLogTriggerSql } from "../markInputTriggers.js";
import { expenseKeySql } from "../expenseKeys.js";
import { expenseKeyParts } from "./flowKeyResolve.js";
import { reinstallFlowDeleteTriggers, reinstallFlowInsertTrigger } from "./flowTables279.js";

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

/** The row table a piece's `source` names. */
const PIECE_SOURCE_TABLE = { cc: "cc_statement_lines", checking: "movements" } as const;

export function runFlowParts283(dbi: DatabaseType): void {
  const before = count(dbi, "cc_expense_line_splits");
  const rows = dbi.prepare(`SELECT * FROM cc_expense_line_splits ORDER BY source, line_id, seq`).all() as {
    source: "cc" | "checking";
    line_id: number;
    seq: number;
    category_id: number;
    amount_clp: number;
    note: string | null;
    spent_on: string | null;
  }[];
  const insert = dbi.prepare(
    `INSERT INTO flow_parts (flow_id, seq, category_id, amount_clp, note, spent_on) VALUES (?, ?, ?, ?, ?, ?)`
  );
  const archive = dbi.prepare(`INSERT INTO flow_orphan_assignments (source_table, purchase_key, payload) VALUES (?, ?, ?)`);
  let moved = 0;
  let archived = 0;
  for (const r of rows) {
    const table = PIECE_SOURCE_TABLE[r.source];
    if (!table) throw new Error(`migration 283: piece source ${String(r.source)}`);
    const row = dbi.prepare(`SELECT flow_id FROM ${table} WHERE id = ?`).get(r.line_id) as { flow_id: number } | undefined;
    if (!row) {
      archive.run("cc_expense_line_splits", `${r.source}:${r.line_id}`, JSON.stringify(r));
      archived += 1;
      continue;
    }
    const sharing = (dbi.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE flow_id = ?`).get(row.flow_id) as { c: number }).c;
    if (sharing !== 1) throw new Error(`migration 283: ${r.source} line ${r.line_id} shares its flow with ${sharing - 1} other row(s)`);
    insert.run(row.flow_id, r.seq, r.category_id, r.amount_clp, r.note, r.spent_on);
    moved += 1;
  }
  const after = count(dbi, "flow_parts");
  console.log(`migration 283: cc_expense_line_splits ${before} → flow_parts ${after} + ${archived} archived (line not on file)`);
  if (after !== moved || moved + archived !== before) throw new Error(`migration 283: ${before} rows became ${after} + ${archived}`);
  dbi.exec(`DROP TABLE cc_expense_line_splits`);
  installWriteLog(dbi, "flow_parts");
  // A line a re-import deletes leaves its pieces on its flow for the re-key mover to carry.
  reinstallFlowDeleteTriggers(dbi, ["flow_parts"]);
}

export function runFlowLinksFinancing284(dbi: DatabaseType): void {
  const before = count(dbi, "cc_facturado_financing_link_purchases");
  const rows = dbi.prepare(`SELECT * FROM cc_facturado_financing_link_purchases`).all() as {
    link_id: number;
    financing_account_id: number;
    financing_purchase_key: string;
  }[];
  const flowOf = dbi.prepare(`SELECT id FROM flows WHERE legacy_key = ?`);
  const insert = dbi.prepare(
    `INSERT INTO flow_links (flow_id, portion, piece_seq, kind, financing_link_id, account_id)
     VALUES (?, ?, ?, 'finances_facturado', ?, ?)`
  );
  for (const r of rows) {
    const parts = expenseKeyParts(r.financing_purchase_key);
    if (!parts) throw new Error(`migration 284: «${r.financing_purchase_key}» is not an expense key`);
    const flow = flowOf.get(parts.flowKey) as { id: number } | undefined;
    // A financing link names the plans that paid a facturado: one that names no plan is a broken link.
    if (!flow) throw new Error(`migration 284: financing link ${r.link_id} names «${r.financing_purchase_key}», which no row carries`);
    insert.run(flow.id, parts.portion, parts.pieceSeq ?? -1, r.link_id, r.financing_account_id);
  }
  const after = count(dbi, "flow_links");
  console.log(`migration 284: cc_facturado_financing_link_purchases ${before} → flow_links ${after}`);
  if (after !== before) throw new Error(`migration 284: ${before} rows became ${after}`);
  dbi.exec(`DROP TABLE cc_facturado_financing_link_purchases`);
  installWriteLog(dbi, "flow_links");
}

/** The movement-delete trigger of the deposit links: a link to a deposit whose movement is gone goes with it. */
export const FUNDED_DEPOSIT_COUNTERPART_TRIGGER_SQL = `CREATE TRIGGER flow_links_counterpart_movement_ad AFTER DELETE ON movements BEGIN
  DELETE FROM flow_links WHERE kind = 'funded_deposit' AND counterpart_flow_id = OLD.flow_id
    AND NOT EXISTS (SELECT 1 FROM movements x WHERE x.flow_id = OLD.flow_id);
END`;

/** `expense_deposit_links` as its readers saw it, rebuilt from the flow links (the proof's read-back). */
const LEGACY_DEPOSIT_LINK_COLUMNS = [
  "account_id",
  "payment_clp",
  "amortization_clp",
  "depto_cuota",
  "depto_occurred_on",
  "link_source",
  "created_at",
] as const;

export function runFlowLinksFundedDeposit285(dbi: DatabaseType): void {
  // 1. The financing links onto the rebuilt table, their order (rowid = the old id) kept.
  const financing = count(dbi, "flow_links");
  dbi.exec(
    `INSERT INTO flow_links_285 (rowid, flow_id, portion, piece_seq, kind, financing_link_id, account_id, created_at)
     SELECT id, flow_id, portion, piece_seq, kind, financing_link_id, account_id, created_at FROM flow_links ORDER BY id`
  );
  if (count(dbi, "flow_links_285") !== financing) throw new Error(`migration 285: financing links not copied whole`);
  dbi.exec(`DROP TABLE flow_links`);
  dbi.exec(`ALTER TABLE flow_links_285 RENAME TO flow_links`);
  dbi.exec(
    `CREATE UNIQUE INDEX idx_flow_links_financing ON flow_links(financing_link_id, flow_id, portion, piece_seq)
       WHERE kind = 'finances_facturado'`
  );
  dbi.exec(
    `CREATE UNIQUE INDEX idx_flow_links_funded_deposit ON flow_links(flow_id, portion, piece_seq, counterpart_flow_id)
       WHERE kind = 'funded_deposit'`
  );
  dbi.exec(`CREATE INDEX idx_flow_links_flow ON flow_links(flow_id)`);
  dbi.exec(`CREATE INDEX idx_flow_links_counterpart_flow ON flow_links(counterpart_flow_id)`);

  // 2. The deposit links: purchase key → its flow; deposit movement → the deposit's flow.
  const before = count(dbi, "expense_deposit_links");
  const rows = dbi.prepare(`SELECT rowid AS _rowid, * FROM expense_deposit_links ORDER BY rowid`).all() as ({
    _rowid: number;
    purchase_key: string;
    deposit_movement_id: number;
  } & Record<(typeof LEGACY_DEPOSIT_LINK_COLUMNS)[number], string | number | null>)[];
  const flowOf = dbi.prepare(`SELECT id FROM flows WHERE legacy_key = ?`);
  const depositFlow = dbi.prepare(
    `SELECT m.flow_id, (SELECT COUNT(*) FROM movements x WHERE x.flow_id = m.flow_id) AS holders FROM movements m WHERE m.id = ?`
  );
  const insert = dbi.prepare(
    `INSERT INTO flow_links (flow_id, portion, piece_seq, kind, counterpart_flow_id, account_id, payment_clp,
       amortization_clp, depto_cuota, depto_occurred_on, link_source, created_at)
     VALUES (?, ?, ?, 'funded_deposit', ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const archive = dbi.prepare(`INSERT INTO flow_orphan_assignments (source_table, purchase_key, payload) VALUES (?, ?, ?)`);
  let moved = 0;
  let archived = 0;
  for (const r of rows) {
    const parts = expenseKeyParts(r.purchase_key);
    if (!parts) throw new Error(`migration 285: expense_deposit_links holds «${r.purchase_key}», which is not an expense key`);
    const dep = depositFlow.get(r.deposit_movement_id) as { flow_id: number | null; holders: number } | undefined;
    if (!dep || dep.flow_id == null) throw new Error(`migration 285: deposit movement ${r.deposit_movement_id} has no flow`);
    // The claim is the deposit's flow (bug 8): it must be that one movement's.
    if (dep.holders !== 1) throw new Error(`migration 285: deposit movement ${r.deposit_movement_id} shares its flow`);
    const flow = flowOf.get(parts.flowKey) as { id: number } | undefined;
    const { _rowid, ...payload } = r;
    void _rowid;
    if (!flow) {
      archive.run("expense_deposit_links", r.purchase_key, JSON.stringify(payload));
      archived += 1;
      continue;
    }
    insert.run(
      flow.id,
      parts.portion,
      parts.pieceSeq ?? -1,
      dep.flow_id,
      ...LEGACY_DEPOSIT_LINK_COLUMNS.map((c) => r[c])
    );
    moved += 1;
  }
  const after = (dbi.prepare(`SELECT COUNT(*) AS c FROM flow_links WHERE kind = 'funded_deposit'`).get() as { c: number }).c;
  console.log(
    `migration 285: flow_links rebuilt (${financing} financing link(s) kept); expense_deposit_links ${before} → flow_links ${after} + ${archived} archived (key names no row)`
  );
  if (after !== moved || moved + archived !== before) throw new Error(`migration 285: ${before} rows became ${after} + ${archived}`);

  // 3. Read back under the old keys and movement ids.
  const keySql = expenseKeySql("f.legacy_key", "l.portion", "NULLIF(l.piece_seq, -1)");
  const readBack = new Set(
    (
      dbi
        .prepare(
          `SELECT ${keySql} AS k, m.id AS deposit_movement_id, ${LEGACY_DEPOSIT_LINK_COLUMNS.map((c) => `l.${c}`).join(", ")}
           FROM flow_links l JOIN flows f ON f.id = l.flow_id JOIN movements m ON m.flow_id = l.counterpart_flow_id
           WHERE l.kind = 'funded_deposit'`
        )
        .all() as Record<string, unknown>[]
    ).map((n) => JSON.stringify([n.k, n.deposit_movement_id, ...LEGACY_DEPOSIT_LINK_COLUMNS.map((c) => n[c])]))
  );
  for (const r of rows) {
    if (!flowOf.get(expenseKeyParts(r.purchase_key)!.flowKey)) continue;
    const sig = JSON.stringify([r.purchase_key, r.deposit_movement_id, ...LEGACY_DEPOSIT_LINK_COLUMNS.map((c) => r[c])]);
    if (!readBack.has(sig)) throw new Error(`migration 285: «${r.purchase_key}» → ${r.deposit_movement_id} does not read back`);
  }
  dbi.exec(`DROP TABLE expense_deposit_links`);
  installWriteLog(dbi, "flow_links");
  dbi.exec(FUNDED_DEPOSIT_COUNTERPART_TRIGGER_SQL);
}

/**
 * A key-named table onto `bill` rows of `to` (flow + the bill as `counterpart_entry_id`): moved in
 * the old table's row order, a key naming nothing archived; returns the counts.
 */
function moveBillKeyed(
  dbi: DatabaseType,
  from: string,
  to: "flow_links" | "flow_link_rejections",
  extraColumns: readonly string[]
): { before: number; moved: number; archived: number } {
  const before = count(dbi, from);
  const rows = dbi.prepare(`SELECT rowid AS _rowid, * FROM ${from} ORDER BY rowid`).all() as ({
    _rowid: number;
    expense_entry_id: number;
    purchase_key: string;
  } & Record<string, string | number | null>)[];
  const flowOf = dbi.prepare(`SELECT id FROM flows WHERE legacy_key = ?`);
  const insert = dbi.prepare(
    `INSERT INTO ${to} (flow_id, portion, piece_seq, kind, counterpart_entry_id${extraColumns.map((c) => `, ${c}`).join("")})
     VALUES (?, ?, ?, 'bill', ?${extraColumns.map(() => ", ?").join("")})`
  );
  const archive = dbi.prepare(`INSERT INTO flow_orphan_assignments (source_table, purchase_key, payload) VALUES (?, ?, ?)`);
  let moved = 0;
  let archived = 0;
  for (const r of rows) {
    const parts = expenseKeyParts(r.purchase_key);
    if (!parts) throw new Error(`migration 286: ${from} holds «${r.purchase_key}», which is not an expense key`);
    const flow = flowOf.get(parts.flowKey) as { id: number } | undefined;
    const { _rowid, ...payload } = r;
    void _rowid;
    if (!flow) {
      archive.run(from, r.purchase_key, JSON.stringify(payload));
      archived += 1;
      continue;
    }
    insert.run(flow.id, parts.portion, parts.pieceSeq ?? -1, r.expense_entry_id, ...extraColumns.map((c) => r[c]));
    moved += 1;
  }
  const after = (dbi.prepare(`SELECT COUNT(*) AS c FROM ${to} WHERE kind = 'bill'`).get() as { c: number }).c;
  console.log(`migration 286: ${from} ${before} → ${to} ${after} + ${archived} archived (key names no row)`);
  if (after !== moved || moved + archived !== before) throw new Error(`migration 286: ${from}: ${before} rows became ${after} + ${archived}`);
  // Read back under the old keys.
  const keySql = expenseKeySql("f.legacy_key", "n.portion", "NULLIF(n.piece_seq, -1)");
  const readBack = new Set(
    (
      dbi
        .prepare(
          `SELECT ${keySql} AS k, n.counterpart_entry_id AS e${extraColumns.map((c) => `, n.${c}`).join("")}
           FROM ${to} n JOIN flows f ON f.id = n.flow_id WHERE n.kind = 'bill'`
        )
        .all() as Record<string, unknown>[]
    ).map((n) => JSON.stringify([n.k, n.e, ...extraColumns.map((c) => n[c])]))
  );
  for (const r of rows) {
    if (!flowOf.get(expenseKeyParts(r.purchase_key)!.flowKey)) continue;
    if (!readBack.has(JSON.stringify([r.purchase_key, r.expense_entry_id, ...extraColumns.map((c) => r[c])]))) {
      throw new Error(`migration 286: ${from} «${r.purchase_key}» → bill ${r.expense_entry_id} does not read back`);
    }
  }
  return { before, moved, archived };
}

export function runFlowLinksBill286(dbi: DatabaseType): void {
  moveBillKeyed(dbi, "real_estate_expense_links", "flow_links", ["link_source", "created_at"]);
  moveBillKeyed(dbi, "real_estate_expense_link_rejections", "flow_link_rejections", ["created_at"]);
  dbi.exec(`DROP TABLE real_estate_expense_links`);
  dbi.exec(`DROP TABLE real_estate_expense_link_rejections`);
  installWriteLog(dbi, "flow_link_rejections");
}

export function runFlowNotes287(dbi: DatabaseType): void {
  moveKeyedTable(dbi, "287", "cc_expense_purchase_notes", "flow_notes", "purchase_key", ["account_id", "notes", "updated_at"]);
}

/**
 * Manual expenses are `purchase` flows, not `card_purchase` (no card line stands behind them): the
 * existing flows are re-kinded and the insert trigger writes the new kind.
 */
export function runFlowKindsManualPurchase288(dbi: DatabaseType): void {
  const changed = dbi
    .prepare(
      `UPDATE flows SET kind = 'purchase'
       WHERE kind = 'card_purchase' AND id IN (SELECT flow_id FROM expense_entries WHERE expense_account_id IS NULL AND flow_id IS NOT NULL)`
    )
    .run().changes;
  const manual = (
    dbi.prepare(`SELECT COUNT(*) AS c FROM expense_entries WHERE expense_account_id IS NULL`).get() as { c: number }
  ).c;
  const left = (
    dbi
      .prepare(
        `SELECT COUNT(*) AS c FROM expense_entries e JOIN flows f ON f.id = e.flow_id
         WHERE e.expense_account_id IS NULL AND f.kind <> 'purchase'`
      )
      .get() as { c: number }
  ).c;
  console.log(`migration 288: ${changed} manual expense flow(s) re-kinded purchase (${manual} manual expenses)`);
  if (left > 0) throw new Error(`migration 288: ${left} manual expense(s) on a flow of another kind`);
  reinstallFlowInsertTrigger(dbi, "expense_entries");
}
