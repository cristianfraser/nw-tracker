/**
 * The Chile day a flow first reached the ledger (`flow_first_seen`, migration 310). Written when a
 * card line is inserted (the first insert wins), kept at the earlier day when two flows merge or a
 * re-import gives a line a new row, read by the expense lines (`first_seen_on`).
 */
import type { Database } from "better-sqlite3";
import { db } from "../db.js";
import { chileCalendarTodayYmd } from "../chileDate.js";

/** Records today (Chile) as the first-seen day of the card line's flow, unless its flow has one. */
export function recordCardLineFlowFirstSeen(lineId: number, day: string = chileCalendarTodayYmd(), dbHandle: Database = db): void {
  dbHandle
    .prepare(
      `INSERT OR IGNORE INTO flow_first_seen (flow_id, first_seen_on)
       SELECT flow_id, ? FROM cc_statement_lines WHERE id = ? AND flow_id IS NOT NULL`
    )
    .run(day, lineId);
}

/** The flow's first-seen day becomes `day` when it has none or a later one. */
export function keepEarlierFlowFirstSeen(flowId: number, day: string, dbHandle: Database = db): void {
  dbHandle
    .prepare(
      `INSERT INTO flow_first_seen (flow_id, first_seen_on) VALUES (?, ?)
       ON CONFLICT(flow_id) DO UPDATE SET first_seen_on = MIN(first_seen_on, excluded.first_seen_on)`
    )
    .run(flowId, day);
}

/**
 * Moves `from`'s first-seen day onto `to`, keeping the earlier of the two (before `from` is
 * deleted; its row would cascade away).
 */
export function carryFlowFirstSeen(from: number, to: number, dbHandle: Database = db): void {
  if (from === to) return;
  const row = dbHandle.prepare(`SELECT first_seen_on FROM flow_first_seen WHERE flow_id = ?`).get(from) as
    | { first_seen_on: string }
    | undefined;
  if (row) keepEarlierFlowFirstSeen(to, row.first_seen_on, dbHandle);
  dbHandle.prepare(`DELETE FROM flow_first_seen WHERE flow_id = ?`).run(from);
}

/** First-seen days of the card lines of an account, by line id (lines whose flow has one). */
export function cardLineFirstSeenForAccount(accountId: number, dbHandle: Database = db): Map<number, string> {
  const rows = dbHandle
    .prepare(
      `SELECT l.id, f.first_seen_on FROM cc_statement_lines l
       JOIN cc_statements s ON s.id = l.statement_id
       JOIN flow_first_seen f ON f.flow_id = l.flow_id
       WHERE s.account_id = ?`
    )
    .all(accountId) as { id: number; first_seen_on: string }[];
  return new Map(rows.map((r) => [r.id, r.first_seen_on]));
}

/** First-seen days of every card line, by line id (lines whose flow has one). */
export function cardLineFirstSeenByLineId(dbHandle: Database = db): Map<number, string> {
  const rows = dbHandle
    .prepare(`SELECT l.id, f.first_seen_on FROM cc_statement_lines l JOIN flow_first_seen f ON f.flow_id = l.flow_id`)
    .all() as { id: number; first_seen_on: string }[];
  return new Map(rows.map((r) => [r.id, r.first_seen_on]));
}

/** Every flow's first-seen day. */
export function flowFirstSeenByFlowId(dbHandle: Database = db): Map<number, string> {
  const rows = dbHandle.prepare(`SELECT flow_id, first_seen_on FROM flow_first_seen`).all() as { flow_id: number; first_seen_on: string }[];
  return new Map(rows.map((r) => [r.flow_id, r.first_seen_on]));
}
