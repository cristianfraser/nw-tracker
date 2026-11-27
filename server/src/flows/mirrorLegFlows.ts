/**
 * The flow identity through a mirror conversion and its undo (`movementMirrorConvert.ts`,
 * `ccPaymentMirrors.ts`). A conversion reshapes bank rows into one transfer; the transfer is the
 * money those rows listed, so it keeps what the user knew them by: the older arrival of its legs
 * (its place in «Últimos movimientos»), the earliest stated event time, and every assignment
 * (category, note, big group, pieces, links). An undo hands it back to the restored legs.
 *
 * Conversion: each leg's flow folds into the transfer's (`mergeFlowInto`), and the transfer's flow
 * answers to the transfer's key (`checking-mv:<transfer>`), the key its lines read. Two legs that
 * carry the same kind of assignment on the same portion and piece with different values (two notes,
 * two big groups, two categories, two sets of pieces) are refused: one transfer holds one of each,
 * and neither is the user's obvious choice. Equal values are one assignment. A leg marked as a
 * refund of spending is refused too: like a credit classified as income, it is not a transfer leg.
 *
 * Undo: the restored legs have new ids and fresh flows. Each first takes back a flow retired with
 * its own document (`adoptRetiredMovementFlow`: a conversion made before the legs' flows were
 * folded left them retired). Then every restored leg takes the transfer's arrival and event time
 * (the legs' own arrivals were folded into one at conversion: the older of the two), the category
 * and note rows written under the inflow leg's account go back to the inflow leg, and everything
 * else — the transfer's flow itself — goes to the outflow leg. A restored leg's flow answers to
 * the key its line reads when it holds something.
 */
import type { Database } from "better-sqlite3";
import { db } from "../db.js";
import { expenseKeyParts, flowIdForKey, mergeFlowInto, movementFlowId } from "./flowIdentity.js";
import { copyFlowFirstSeen } from "./flowFirstSeen.js";
import { copyFlowEventTime } from "./flowEventTimes.js";
import { adoptRetiredMovementFlow } from "./flowAdoption.js";
import { FLOW_HOLDING_TABLES } from "./flowTriggerSpecs.js";

/** Key-named assignment tables (one row per flow, portion and piece) and the column that is their value. */
const KEYED_VALUE_TABLES: readonly { table: string; value: string }[] = [
  { table: "flow_categories", value: "category_id" },
  { table: "flow_notes", value: "notes" },
  { table: "flow_big_groups", value: "group_slug" },
];

/**
 * Why two legs' flows cannot become one transfer's flow (null when they can): a refund mark on
 * either, two different values of one key-named assignment, or pieces on both.
 */
export function mirrorLegFlowsConflict(legFlowIds: readonly number[], dbHandle: Database = db): string | null {
  for (const f of legFlowIds) {
    if (dbHandle.prepare(`SELECT 1 FROM flow_refunds WHERE flow_id = ?`).get(f) != null) {
      return `flow ${f} is marked as a refund of spending, not a transfer leg`;
    }
  }
  if (legFlowIds.length < 2) return null;
  const [a, b] = legFlowIds as [number, number];
  if (a === b) return null;
  for (const { table, value } of KEYED_VALUE_TABLES) {
    const clash = dbHandle
      .prepare(
        `SELECT x.portion, x.piece_seq FROM ${table} x JOIN ${table} y
           ON y.flow_id = ? AND y.portion = x.portion AND y.piece_seq = x.piece_seq
         WHERE x.flow_id = ? AND x.${value} IS NOT y.${value} LIMIT 1`
      )
      .get(b, a) as { portion: string; piece_seq: number } | undefined;
    if (clash) return `both legs carry a different ${table} row (${clash.portion}, piece ${clash.piece_seq}); keep one and retry`;
  }
  const hasParts = (f: number) => dbHandle.prepare(`SELECT 1 FROM flow_parts WHERE flow_id = ?`).get(f) != null;
  if (hasParts(a) && hasParts(b)) return `both legs are split into pieces; keep one split and retry`;
  return null;
}

/** Whether anything hangs off a flow (the assignments the flow-retirement triggers keep a flow for). */
function flowHoldsAssignments(flowId: number, dbHandle: Database): boolean {
  const tables = [...FLOW_HOLDING_TABLES, "flow_links"];
  if (tables.some((t) => dbHandle.prepare(`SELECT 1 FROM ${t} WHERE flow_id = ?`).get(flowId) != null)) return true;
  return dbHandle.prepare(`SELECT 1 FROM card_refund_links WHERE flow_id = ? OR purchase_flow_id = ?`).get(flowId, flowId) != null;
}

/**
 * The flow answers to `key` (the key its row's lines read), when it holds something: the readers
 * see key-named rows only through it. A flow already answering to the key folds in (its
 * assignments lose to this flow's).
 */
function answerToKeyWhenHolding(flowId: number, key: string, dbHandle: Database): void {
  if (!flowHoldsAssignments(flowId, dbHandle)) return;
  const parts = expenseKeyParts(key);
  if (!parts) throw new Error(`not an expense purchase key: «${key}»`);
  const holder = flowIdForKey(parts.flowKey, dbHandle);
  if (holder === flowId) return;
  if (holder != null) mergeFlowInto(holder, flowId, "to", dbHandle);
  dbHandle.prepare(`UPDATE flows SET legacy_key = ? WHERE id = ?`).run(parts.flowKey, flowId);
}

function eventTimeOf(flowId: number, dbHandle: Database): string | null {
  return (dbHandle.prepare(`SELECT occurred_at FROM flow_event_times WHERE flow_id = ?`).get(flowId) as { occurred_at: string } | undefined)
    ?.occurred_at ?? null;
}

/**
 * Folds the legs' flows into the transfer's, before the legs are deleted. The caller has checked
 * {@link mirrorLegFlowsConflict}. The earliest stated event time is the one kept (a flow keeps the
 * first time it is given), the older arrival stays (`mergeFlowInto`).
 */
export function foldMirrorLegFlowsIntoTransfer(
  transferMovementId: number,
  transferKey: string,
  legMovementIds: readonly number[],
  dbHandle: Database = db
): void {
  const transferFlow = movementFlowId(transferMovementId, dbHandle);
  const legs = legMovementIds
    .map((id, i) => {
      const flow = movementFlowId(id, dbHandle);
      return { flow, at: eventTimeOf(flow, dbHandle), i };
    })
    .sort((x, y) => (x.at == null ? 1 : 0) - (y.at == null ? 1 : 0) || (x.at ?? "").localeCompare(y.at ?? "") || x.i - y.i);
  legs.forEach((leg, n) => {
    if (leg.flow === transferFlow) return;
    // The first leg's rows win over the fresh transfer's (it has none); a second leg's equal row is the same assignment.
    mergeFlowInto(leg.flow, transferFlow, n === 0 ? "from" : "to", dbHandle);
  });
  answerToKeyWhenHolding(transferFlow, transferKey, dbHandle);
}

export type RestoredMirrorLeg = { movementId: number; accountId: number; key: () => string };

/**
 * Hands the transfer's flow back to the restored legs, before the transfer is deleted (see the
 * module comment). `out` takes the transfer's flow; `inn` (absent for a card payment, whose card
 * side was never a movement) takes the arrival, the event time and the category and note rows
 * written under its account. Each leg's `key` is read once its listing is restored.
 */
export function restoreMirrorLegFlows(
  transferMovementId: number,
  out: RestoredMirrorLeg,
  inn: RestoredMirrorLeg | null,
  dbHandle: Database = db
): { finish: () => void } {
  const transferFlow = movementFlowId(transferMovementId, dbHandle);
  for (const leg of inn ? [out, inn] : [out]) adoptRetiredMovementFlow(leg.movementId, dbHandle);
  if (inn) {
    const inFlow = movementFlowId(inn.movementId, dbHandle);
    copyFlowFirstSeen(transferFlow, inFlow, dbHandle);
    copyFlowEventTime(transferFlow, inFlow, dbHandle);
    if (inn.accountId !== out.accountId) {
      for (const table of ["flow_categories", "flow_notes"]) {
        dbHandle
          .prepare(
            `DELETE FROM ${table} WHERE flow_id = ? AND EXISTS (SELECT 1 FROM ${table} x
               WHERE x.flow_id = ? AND x.account_id = ? AND x.portion = ${table}.portion AND x.piece_seq = ${table}.piece_seq)`
          )
          .run(inFlow, transferFlow, inn.accountId);
        dbHandle.prepare(`UPDATE ${table} SET flow_id = ? WHERE flow_id = ? AND account_id = ?`).run(inFlow, transferFlow, inn.accountId);
      }
    }
  }
  const outFlow = movementFlowId(out.movementId, dbHandle);
  mergeFlowInto(transferFlow, outFlow, "from", dbHandle);
  // Keys are given once the transfer is gone (its evidence no longer on the outflow leg's flow).
  return {
    finish: () => {
      for (const leg of inn ? [out, inn] : [out]) answerToKeyWhenHolding(movementFlowId(leg.movementId, dbHandle), leg.key(), dbHandle);
    },
  };
}
