/**
 * Adoption on arrival (docs/untangle-flow-identity.md, F9 step 4): a document that records a flow
 * already on file — a statement line settling its bucket line, a re-imported line, a cartola row
 * taking over its daily row, a statement plan replacing its hand-entered twin — attaches to that
 * flow instead of starting a new one. The arriving row's own flow folds into the surviving one, so
 * every assignment (category, «Único», note, big group, pieces, links, refund mark, income
 * classification) stays on the flow the user made it on, and the flow id with it. The flow's own
 * fields follow its most trusted evidence (statement over listing over manual).
 *
 * The recognisers that decide WHICH flow a document records stay with their importers (F17 windows);
 * this module only performs the adoption.
 */
import type { Database } from "better-sqlite3";
import { db } from "../db.js";
import { expenseKeyParts, flowIdForKey, mergeFlowInto } from "./flowIdentity.js";

export type FlowAdoption = {
  /** The flow that stays (the one on file). */
  survivor: number;
  /** The flow the arriving row brought (folded into the survivor). */
  arriving: number;
};

function keyOf(flowId: number, dbHandle: Database): string | null {
  return (dbHandle.prepare(`SELECT legacy_key FROM flows WHERE id = ?`).get(flowId) as { legacy_key: string | null } | undefined)
    ?.legacy_key ?? null;
}

/**
 * Folds `arriving` into `survivor`. `prefer` says whose assignment wins when both carry one (the
 * arriving row may carry one a restore wrote under its key). `key`: the key the arriving row's line
 * answers to while the readers still read keys — the survivor answers to it from now on when it
 * answered to a key before, or another flow holds it (that flow folds in too).
 */
export function adoptFlow(
  adoption: FlowAdoption,
  opts: { prefer: "survivor" | "arriving"; key?: string | null; previousKey?: string | null },
  dbHandle: Database = db
): void {
  const { survivor, arriving } = adoption;
  const flowKey = opts.key ? expenseKeyParts(opts.key)?.flowKey ?? null : null;
  if (opts.key && !flowKey) throw new Error(`not an expense purchase key: «${opts.key}»`);
  // The flow the replaced row's key answered to (the same flow, unless an older one still answers to
  // that key): it is the same purchase, so it folds in too.
  const previousFlowKey = opts.previousKey ? expenseKeyParts(opts.previousKey)?.flowKey ?? null : null;
  const previous = previousFlowKey ? flowIdForKey(previousFlowKey, dbHandle) : null;
  if (previous != null && previous !== survivor && previous !== arriving) mergeFlowInto(previous, survivor, "to", dbHandle);
  const holder = flowKey ? flowIdForKey(flowKey, dbHandle) : null;
  const survivorKeyed = keyOf(survivor, dbHandle) != null || previous != null;
  if (arriving !== survivor) mergeFlowInto(arriving, survivor, opts.prefer === "arriving" ? "from" : "to", dbHandle);
  if (holder != null && holder !== survivor && holder !== arriving) mergeFlowInto(holder, survivor, "to", dbHandle);
  if (flowKey && (survivorKeyed || holder != null)) {
    dbHandle.prepare(`UPDATE flows SET legacy_key = ? WHERE id = ?`).run(flowKey, survivor);
  }
  dbHandle
    .prepare(`UPDATE flows SET retired_on = NULL, retired_source_table = NULL, retired_document_key = NULL WHERE id = ?`)
    .run(survivor);
  refreshFlowFromEvidence(survivor, dbHandle);
}

/**
 * A card flow's amount, day, currency and merchant follow its most trusted line (a statement over a
 * listing; the newest row among equals). Movements keep theirs: their evidence states the bank's
 * signed figure and its provenance text, not the flow's ends.
 */
export function refreshFlowFromEvidence(flowId: number, dbHandle: Database = db): void {
  const best = dbHandle
    .prepare(
      `SELECT stated_on, stated_amount, stated_currency, stated_description FROM flow_evidence
       WHERE flow_id = ? AND source_table = 'cc_statement_lines' AND stated_on IS NOT NULL AND stated_amount IS NOT NULL
       ORDER BY authority DESC, id DESC LIMIT 1`
    )
    .get(flowId) as
    | { stated_on: string; stated_amount: number; stated_currency: string | null; stated_description: string | null }
    | undefined;
  if (!best) return;
  dbHandle
    .prepare(
      `UPDATE flows SET occurred_on = ?, amount = abs(?), currency = COALESCE(?, currency), description = ? WHERE id = ?`
    )
    .run(best.stated_on, best.stated_amount, best.stated_currency, best.stated_description, flowId);
}

/** The flow a row points at (null when the row is gone or has none). */
export function rowFlowId(table: "movements" | "cc_statement_lines" | "cc_installment_purchases", id: number, dbHandle: Database = db): number | null {
  return (dbHandle.prepare(`SELECT flow_id FROM ${table} WHERE id = ?`).get(id) as { flow_id: number | null } | undefined)?.flow_id ?? null;
}

/** Whether a flow is still on file (a retired flow is; a bare one deleted with its rows is not). */
export function flowExists(flowId: number | null | undefined, dbHandle: Database = db): flowId is number {
  return flowId != null && dbHandle.prepare(`SELECT 1 FROM flows WHERE id = ?`).get(flowId) != null;
}

export type RetiredMovementAdoption =
  | { status: "adopted"; movement_id: number; flow_id: number }
  | { status: "ambiguous"; movement_id: number; flow_ids: number[] }
  | null;

/**
 * A bank row arriving again (a cartola month re-imported, a daily row listed again): when a flow
 * retired with the same document on the same account is on file, the row takes it back. Exact
 * document identity only; several candidates are reported and left alone.
 */
export function adoptRetiredMovementFlow(movementId: number, dbHandle: Database = db): RetiredMovementAdoption {
  const row = dbHandle
    .prepare(
      `SELECT m.flow_id, m.account_id, e.document_key FROM movements m
       JOIN flow_evidence e ON e.source_table = 'movements' AND e.source_row_id = m.id
       WHERE m.id = ?`
    )
    .get(movementId) as { flow_id: number; account_id: number | null; document_key: string | null } | undefined;
  if (!row?.document_key || row.account_id == null) return null;
  const candidates = (
    dbHandle
      .prepare(
        `SELECT id FROM flows WHERE retired_on IS NOT NULL AND retired_source_table = 'movements' AND retired_document_key = ?
           AND (from_account_id = ? OR to_account_id = ?) AND id <> ? ORDER BY id`
      )
      .all(row.document_key, row.account_id, row.account_id, row.flow_id) as { id: number }[]
  ).map((r) => r.id);
  if (candidates.length === 0) return null;
  if (candidates.length > 1) return { status: "ambiguous", movement_id: movementId, flow_ids: candidates };
  adoptFlow({ survivor: candidates[0]!, arriving: row.flow_id }, { prefer: "survivor" }, dbHandle);
  return { status: "adopted", movement_id: movementId, flow_id: candidates[0]! };
}
