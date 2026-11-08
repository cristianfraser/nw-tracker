/**
 * The flow identity at runtime (docs/untangle-flow-identity.md, F9 step 3). Every movement, card
 * line, plan and manual expense points at a flow (`flow_id`, written by the migration 279 triggers
 * for rows written later), and every assignment — category, «Único», note, big group, piece, link,
 * refund mark, income classification — hangs off a flow. During the transition the expense lines
 * still carry their key (`purchase_key`): a flow answers to the key it was born from
 * (`flows.legacy_key`), the readers join on it, and a write names its flow through
 * {@link ensureFlowForKey}. Adoption on arrival (step 4) replaces the key with the stored match.
 */
import type { Database } from "better-sqlite3";
import { db } from "../db.js";
import { expenseKeySql } from "../expenseKeys.js";
import { expenseKeyParts, resolveExpenseKey, type FlowSourceRow } from "./flowKeyResolve.js";

export { expenseKeyParts };

/** The expense key an assignment row stands for: its flow's key, the deposit portion, the piece. */
export function flowAssignmentKeySql(flowAlias: string, portionCol: string | null, pieceCol: string | null): string {
  return expenseKeySql(`${flowAlias}.legacy_key`, portionCol, pieceCol);
}

/** A movement's flow (every movement has one: migration 279 and its triggers). */
export function movementFlowId(movementId: number, dbHandle: Database = db): number {
  const row = dbHandle.prepare(`SELECT flow_id FROM movements WHERE id = ?`).get(movementId) as { flow_id: number | null } | undefined;
  if (!row) throw Object.assign(new Error(`movement ${movementId} not found`), { status: 404 });
  if (row.flow_id == null) throw new Error(`movement ${movementId} has no flow`);
  return row.flow_id;
}

/** The flow that carries a key (any portion or piece of it); null when none does yet. */
export function flowIdForKey(key: string, dbHandle: Database = db): number | null {
  const parts = expenseKeyParts(key);
  if (!parts) throw new Error(`not an expense purchase key: «${key}»`);
  const row = dbHandle.prepare(`SELECT id FROM flows WHERE legacy_key = ?`).get(parts.flowKey) as { id: number } | undefined;
  return row?.id ?? null;
}

function rowFlowId(row: FlowSourceRow, dbHandle: Database): number | null {
  if (row.table === "checking_gap_deposit_mirrors") {
    const e = dbHandle
      .prepare(`SELECT flow_id FROM flow_evidence WHERE source_table = ? AND source_row_id = ?`)
      .get(row.table, row.id) as { flow_id: number } | undefined;
    return e?.flow_id ?? null;
  }
  const r = dbHandle.prepare(`SELECT flow_id FROM ${row.table} WHERE id = ?`).get(row.id) as { flow_id: number | null } | undefined;
  return r?.flow_id ?? null;
}

/**
 * The flow a write names by its key: the flow that carries the key, else the flow of the rows the
 * key names, stamped with it (rows of the same key on flows of their own join the first). Throws
 * when the key names no row: an assignment must hang off something a document records.
 */
export function ensureFlowForKey(key: string, dbHandle: Database = db): number {
  const found = flowIdForKey(key, dbHandle);
  if (found != null) return found;
  const resolved = resolveExpenseKey(dbHandle, key)!;
  if (resolved.rows.length === 0) throw new Error(`no expense carries «${key}»`);
  const keyless = new Map<number, FlowSourceRow[]>();
  for (const row of resolved.rows) {
    const f = rowFlowId(row, dbHandle);
    if (f == null) continue;
    const isKeyless = (dbHandle.prepare(`SELECT legacy_key FROM flows WHERE id = ?`).get(f) as { legacy_key: string | null })
      .legacy_key == null;
    if (isKeyless) keyless.set(f, [...(keyless.get(f) ?? []), row]);
  }
  const [target, ...others] = [...keyless.keys()].sort((a, b) => a - b);
  if (target == null) {
    // Every row is evidence of a flow keyed otherwise (a cuota line of a plan named by its plan key):
    // the key gets a flow of its own, copied from the first row's.
    const first = resolved.rows[0]!;
    const src = rowFlowId(first, dbHandle);
    if (src == null) throw new Error(`no flow for ${first.table} ${first.id}`);
    return Number(
      dbHandle
        .prepare(
          `INSERT INTO flows (kind, from_account_id, to_account_id, from_party_id, to_party_id, occurred_on, amount, currency,
             counter_amount, counter_currency, description, legacy_key)
           SELECT kind, from_account_id, to_account_id, from_party_id, to_party_id, occurred_on, amount, currency,
             counter_amount, counter_currency, description, ? FROM flows WHERE id = ?`
        )
        .run(resolved.flowKey, src).lastInsertRowid
    );
  }
  for (const other of others) {
    for (const row of keyless.get(other)!) repointRow(row, target, dbHandle);
    dbHandle.prepare(`DELETE FROM flows WHERE id = ? AND legacy_key IS NULL`).run(other);
  }
  dbHandle.prepare(`UPDATE flows SET legacy_key = ? WHERE id = ?`).run(resolved.flowKey, target);
  return target;
}

function repointRow(row: FlowSourceRow, flowId: number, dbHandle: Database): void {
  if (row.table !== "checking_gap_deposit_mirrors") {
    dbHandle.prepare(`UPDATE ${row.table} SET flow_id = ? WHERE id = ?`).run(flowId, row.id);
  }
  dbHandle.prepare(`UPDATE flow_evidence SET flow_id = ? WHERE source_table = ? AND source_row_id = ?`).run(flowId, row.table, row.id);
}

/**
 * The assignment tables on a flow and what a merge does when both flows carry a row: `prefer` keeps
 * the preferred flow's row, `throw` refuses (two claims on one thing). Each assignment migration adds
 * its table.
 */
type FlowAssignmentTable = { table: string; onConflict: "prefer" | "throw" };
export const FLOW_ASSIGNMENT_TABLES: readonly FlowAssignmentTable[] = [
  { table: "flow_refunds", onConflict: "throw" },
  { table: "flow_income_overrides", onConflict: "throw" },
];

/**
 * Moves every assignment of flow `from` onto `to`, then deletes `from`; on a conflict the row of
 * the `prefer`red flow stays (or the merge throws, per table).
 */
export function mergeFlowInto(from: number, to: number, prefer: "from" | "to", dbHandle: Database = db): void {
  if (from === to) return;
  for (const { table, onConflict } of FLOW_ASSIGNMENT_TABLES) {
    const fromRows = dbHandle.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE flow_id = ?`).get(from) as { c: number };
    if (fromRows.c === 0) continue;
    const cols = (dbHandle.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as { name: string }[]).map((c) => c.name);
    const select = cols.map((c) => (c === "flow_id" ? "?" : c)).join(", ");
    if (onConflict === "throw") {
      dbHandle.prepare(`INSERT INTO ${table} (${cols.join(", ")}) SELECT ${select} FROM ${table} WHERE flow_id = ?`).run(to, from);
    } else {
      const verb = prefer === "from" ? "INSERT OR REPLACE" : "INSERT OR IGNORE";
      dbHandle.prepare(`${verb} INTO ${table} (${cols.join(", ")}) SELECT ${select} FROM ${table} WHERE flow_id = ?`).run(to, from);
    }
    dbHandle.prepare(`DELETE FROM ${table} WHERE flow_id = ?`).run(from);
  }
  for (const t of ["movements", "cc_statement_lines", "cc_installment_purchases", "expense_entries", "income_entries"]) {
    dbHandle.prepare(`UPDATE ${t} SET flow_id = ? WHERE flow_id = ?`).run(to, from);
  }
  dbHandle.prepare(`UPDATE flow_evidence SET flow_id = ? WHERE flow_id = ?`).run(to, from);
  // The merged flow's own links move by row (the rowid, their read order, stays): a bill pairs with
  // one purchase, so a survivor already linked to another bill makes the update fail (the one
  // bill-move policy, docs/untangle-flow-identity.md); a refusal the survivor already carries stays.
  dbHandle.prepare(`UPDATE flow_links SET flow_id = ? WHERE flow_id = ?`).run(to, from);
  dbHandle.prepare(`UPDATE OR IGNORE flow_link_rejections SET flow_id = ? WHERE flow_id = ?`).run(to, from);
  // A link that points at the merged flow (a deposit a purchase funded) points at the survivor.
  dbHandle.prepare(`UPDATE OR IGNORE flow_links SET counterpart_flow_id = ? WHERE counterpart_flow_id = ?`).run(to, from);
  dbHandle.prepare(`DELETE FROM flows WHERE id = ?`).run(from);
}

/**
 * A row that replaces another (the cartola row a daily row was a preview of) takes over its flow:
 * the new row's own flow is merged into the old one (the old flow's assignments win: the user made
 * them), and the old flow answers to the new row's key. Bug 2: the refund mark, the income
 * classification and every key-named assignment follow the flow instead of being dropped with the
 * old row.
 */
export function adoptMovementFlow(fromMovementId: number, toMovementId: number, newKey: string, dbHandle: Database = db): void {
  const flowOf = (id: number) =>
    (dbHandle.prepare(`SELECT flow_id FROM movements WHERE id = ?`).get(id) as { flow_id: number | null } | undefined)?.flow_id ?? null;
  const from = flowOf(fromMovementId);
  const to = flowOf(toMovementId);
  if (from == null || to == null) throw new Error(`movements ${fromMovementId} / ${toMovementId}: no flow`);
  if (from === to) return;
  // The surviving flow is the old row's; a flow already answering to the new key folds into it.
  const parts = expenseKeyParts(newKey);
  if (!parts) throw new Error(`not an expense purchase key: «${newKey}»`);
  const holder = flowIdForKey(parts.flowKey, dbHandle);
  mergeFlowInto(to, from, "to", dbHandle);
  if (holder != null && holder !== from && holder !== to) mergeFlowInto(holder, from, "to", dbHandle);
  dbHandle.prepare(`UPDATE flows SET legacy_key = ? WHERE id = ?`).run(parts.flowKey, from);
}

/**
 * The flow each expense line is (`flow_id` on the Expenses lines, F9 step 3): the flow its key
 * names, else the flow of the row it was built from (a card line, a plan's own line, a checking
 * movement, a manual expense, a gap mirror); none for a payslip deduction (no flow in step 3).
 */
export function withExpenseLineFlowIds<
  L extends { source: string; statement_line_id: number; purchase_key: string; installment_purchase_id?: number }
>(lines: readonly L[], dbHandle: Database = db): (L & { flow_id?: number })[] {
  const byKey = new Map(
    (dbHandle.prepare(`SELECT legacy_key AS k, id FROM flows WHERE legacy_key IS NOT NULL`).all() as { k: string; id: number }[]).map(
      (r) => [r.k, r.id]
    )
  );
  const rowFlows = (table: string) =>
    new Map(
      (dbHandle.prepare(`SELECT id, flow_id FROM ${table} WHERE flow_id IS NOT NULL`).all() as { id: number; flow_id: number }[]).map(
        (r) => [r.id, r.flow_id]
      )
    );
  const lines_ = rowFlows("cc_statement_lines");
  const movements = rowFlows("movements");
  const plans = rowFlows("cc_installment_purchases");
  const entries = rowFlows("expense_entries");
  const mirrors = new Map(
    (
      dbHandle
        .prepare(`SELECT source_row_id AS id, flow_id FROM flow_evidence WHERE source_table = 'checking_gap_deposit_mirrors'`)
        .all() as { id: number; flow_id: number }[]
    ).map((r) => [r.id, r.flow_id])
  );
  return lines.map((l) => {
    const keyed = byKey.get(expenseKeyParts(l.purchase_key)?.flowKey ?? "");
    let flowId = keyed;
    if (flowId == null) {
      if (l.source === "cc") {
        flowId = l.statement_line_id > 0 ? lines_.get(l.statement_line_id) : plans.get(l.installment_purchase_id ?? -1);
      } else if (l.source === "checking") {
        flowId = l.statement_line_id > 0 ? movements.get(l.statement_line_id) : mirrors.get(-l.statement_line_id);
      } else if (l.source === "manual") {
        flowId = entries.get(l.statement_line_id);
      }
    }
    return flowId == null ? { ...l } : { ...l, flow_id: flowId };
  });
}
