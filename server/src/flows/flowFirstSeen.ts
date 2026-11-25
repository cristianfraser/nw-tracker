/**
 * When a flow first reached the ledger (`flow_first_seen`, migrations 310 and 367): the Chile day,
 * the moment (UTC ISO) and the write order (one counter over the table). Written when a card line
 * or a movement is inserted or a manual expense is created (the first write wins), kept at the
 * earlier stamp when two flows merge or a re-import gives a line a new row. The day is read by the
 * expense lines (`first_seen_on`); the order sorts a day's «Últimos movimientos».
 */
import type { Database } from "better-sqlite3";
import { db } from "../db.js";
import { chileCalendarTodayYmd } from "../chileDate.js";
import { listedOldestFirst, type ListingOrder } from "nw-tracker-contracts";

/** A flow's first-seen stamp. `at` and `seq` are null on rows written before migration 367. */
export type FirstSeenStamp = { on: string; at: string | null; seq: number | null };

const NOW_ISO_SQL = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;
const NEXT_SEQ_SQL = `(SELECT COALESCE(MAX(first_seen_seq), 0) + 1 FROM flow_first_seen)`;

/** The latest write order on file (0 when none): a write's own stamps are the ones above it. */
export function maxFirstSeenSeq(dbHandle: Database = db): number {
  return (dbHandle.prepare(`SELECT COALESCE(MAX(first_seen_seq), 0) AS n FROM flow_first_seen`).get() as { n: number }).n;
}

/**
 * Puts the stamps one listing's import wrote (order above `sinceSeq`) in the listing's time order:
 * a listing prints no time, so its rows are written in printed order and their order numbers
 * and times are then handed out again oldest row first (`listing_order`, `listingOrder.ts`). A flow
 * stamped before this write keeps its stamp.
 */
export function orderListingStamps(
  flowIdsAsListed: readonly number[],
  order: ListingOrder,
  sinceSeq: number,
  dbHandle: Database = db
): void {
  const stampOf = dbHandle.prepare(`SELECT first_seen_seq AS seq, first_seen_at AS at FROM flow_first_seen WHERE flow_id = ?`);
  const seen = new Set<number>();
  const written: { flowId: number; seq: number; at: string }[] = [];
  for (const flowId of listedOldestFirst(flowIdsAsListed, order)) {
    if (seen.has(flowId)) continue;
    seen.add(flowId);
    const row = stampOf.get(flowId) as { seq: number | null; at: string | null } | undefined;
    if (row?.seq != null && row.at != null && row.seq > sinceSeq) written.push({ flowId, seq: row.seq, at: row.at });
  }
  // The write's order numbers and times, handed out again oldest row first.
  const seqs = written.map((w) => w.seq).sort((x, y) => x - y);
  const ats = written.map((w) => w.at).sort();
  const set = dbHandle.prepare(`UPDATE flow_first_seen SET first_seen_seq = ?, first_seen_at = ? WHERE flow_id = ?`);
  written.forEach((w, i) => {
    if (w.seq !== seqs[i] || w.at !== ats[i]) set.run(seqs[i], ats[i], w.flowId);
  });
}

/** Stamps the flow as first seen now (Chile day `day`), unless it has a stamp. */
export function recordFlowFirstSeen(flowId: number, day: string = chileCalendarTodayYmd(), dbHandle: Database = db): void {
  dbHandle
    .prepare(
      `INSERT OR IGNORE INTO flow_first_seen (flow_id, first_seen_on, first_seen_at, first_seen_seq)
       VALUES (?, ?, ${NOW_ISO_SQL}, ${NEXT_SEQ_SQL})`
    )
    .run(flowId, day);
}

/** Stamps the card line's flow as first seen now, unless its flow has a stamp. */
export function recordCardLineFlowFirstSeen(lineId: number, day: string = chileCalendarTodayYmd(), dbHandle: Database = db): void {
  const row = dbHandle.prepare(`SELECT flow_id FROM cc_statement_lines WHERE id = ?`).get(lineId) as
    | { flow_id: number | null }
    | undefined;
  if (row?.flow_id != null) recordFlowFirstSeen(row.flow_id, day, dbHandle);
}

/** Stamps the movement's flow as first seen now, unless its flow has a stamp. */
export function recordMovementFlowFirstSeen(movementId: number, dbHandle: Database = db): void {
  const row = dbHandle.prepare(`SELECT flow_id FROM movements WHERE id = ?`).get(movementId) as
    | { flow_id: number | null }
    | undefined;
  if (row?.flow_id != null) recordFlowFirstSeen(row.flow_id, chileCalendarTodayYmd(), dbHandle);
}

/**
 * The flow's stamp becomes `stamp` when it has none or a later one: by day, then time, then order,
 * a missing time or order counting as earlier (a row from before migration 367 was written first).
 */
export function keepEarlierFlowFirstSeen(flowId: number, stamp: FirstSeenStamp, dbHandle: Database = db): void {
  dbHandle
    .prepare(
      `INSERT INTO flow_first_seen (flow_id, first_seen_on, first_seen_at, first_seen_seq) VALUES (?, ?, ?, ?)
       ON CONFLICT(flow_id) DO UPDATE SET
         first_seen_on = excluded.first_seen_on,
         first_seen_at = excluded.first_seen_at,
         first_seen_seq = excluded.first_seen_seq
       WHERE (excluded.first_seen_on, COALESCE(excluded.first_seen_at, ''), COALESCE(excluded.first_seen_seq, 0))
           < (first_seen_on, COALESCE(first_seen_at, ''), COALESCE(first_seen_seq, 0))`
    )
    .run(flowId, stamp.on, stamp.at, stamp.seq);
}

/** Removes the flow's stamp when its day is `day` (what an insert on that day recorded). */
export function dropFlowFirstSeenRecordedOn(flowId: number, day: string, dbHandle: Database = db): void {
  dbHandle.prepare(`DELETE FROM flow_first_seen WHERE flow_id = ? AND first_seen_on = ?`).run(flowId, day);
}

type StampRow = { first_seen_on: string; first_seen_at: string | null; first_seen_seq: number | null };

function stampOf(r: StampRow): FirstSeenStamp {
  return { on: r.first_seen_on, at: r.first_seen_at, seq: r.first_seen_seq };
}

/**
 * Moves `from`'s stamp onto `to`, keeping the earlier of the two (before `from` is deleted; its row
 * would cascade away).
 */
export function carryFlowFirstSeen(from: number, to: number, dbHandle: Database = db): void {
  if (from === to) return;
  const row = dbHandle
    .prepare(`SELECT first_seen_on, first_seen_at, first_seen_seq FROM flow_first_seen WHERE flow_id = ?`)
    .get(from) as StampRow | undefined;
  if (row) keepEarlierFlowFirstSeen(to, stampOf(row), dbHandle);
  dbHandle.prepare(`DELETE FROM flow_first_seen WHERE flow_id = ?`).run(from);
}

/** Stamps of the card lines of an account, by line id (lines whose flow has one). */
export function cardLineFirstSeenForAccount(accountId: number, dbHandle: Database = db): Map<number, FirstSeenStamp> {
  const rows = dbHandle
    .prepare(
      `SELECT l.id, f.first_seen_on, f.first_seen_at, f.first_seen_seq FROM cc_statement_lines l
       JOIN cc_statements s ON s.id = l.statement_id
       JOIN flow_first_seen f ON f.flow_id = l.flow_id
       WHERE s.account_id = ?`
    )
    .all(accountId) as (StampRow & { id: number })[];
  return new Map(rows.map((r) => [r.id, stampOf(r)]));
}

/** First-seen days of every card line, by line id (lines whose flow has one). */
export function cardLineFirstSeenByLineId(dbHandle: Database = db): Map<number, string> {
  const rows = dbHandle
    .prepare(`SELECT l.id, f.first_seen_on FROM cc_statement_lines l JOIN flow_first_seen f ON f.flow_id = l.flow_id`)
    .all() as { id: number; first_seen_on: string }[];
  return new Map(rows.map((r) => [r.id, r.first_seen_on]));
}

/** The write stamp (time in epoch ms, order) of every flow written since migration 367, by flow id. */
export function flowWriteStampsByFlowId(dbHandle: Database = db): Map<number, { atMs: number; seq: number }> {
  const rows = dbHandle
    .prepare(`SELECT flow_id, first_seen_at, first_seen_seq FROM flow_first_seen WHERE first_seen_seq IS NOT NULL`)
    .all() as { flow_id: number; first_seen_at: string; first_seen_seq: number }[];
  return new Map(rows.map((r) => [r.flow_id, { atMs: Date.parse(r.first_seen_at), seq: r.first_seen_seq }]));
}
