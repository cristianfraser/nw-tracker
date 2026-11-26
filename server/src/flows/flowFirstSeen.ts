/**
 * When a flow first reached the ledger (`flow_first_seen`, migrations 310 and 367): the Chile day,
 * the moment (UTC ISO) and the write order (one counter over the table). Written when a card line
 * (a statement's cuota line excepted), a plan, a movement is inserted or a manual expense is created
 * (the first write wins). When two flows become one, the older arrival stays ({@link olderArrival}:
 * a flow with no stamp was on file before the stamps and is older than any). The day is read by the
 * expense lines (`first_seen_on`); the order sorts «Últimos movimientos».
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

/** Stamps the plan's flow as first seen now, unless its flow has a stamp (a plan written new). */
export function recordPlanFlowFirstSeen(planId: number, dbHandle: Database = db): void {
  const row = dbHandle.prepare(`SELECT flow_id FROM cc_installment_purchases WHERE id = ?`).get(planId) as
    | { flow_id: number | null }
    | undefined;
  if (row?.flow_id != null) recordFlowFirstSeen(row.flow_id, chileCalendarTodayYmd(), dbHandle);
}

/** Stamps the movement's flow as first seen now, unless its flow has a stamp. */
export function recordMovementFlowFirstSeen(movementId: number, dbHandle: Database = db): void {
  const row = dbHandle.prepare(`SELECT flow_id FROM movements WHERE id = ?`).get(movementId) as
    | { flow_id: number | null }
    | undefined;
  if (row?.flow_id != null) recordFlowFirstSeen(row.flow_id, chileCalendarTodayYmd(), dbHandle);
}

type StampRow = { first_seen_on: string; first_seen_at: string | null; first_seen_seq: number | null };

function stampOf(r: StampRow): FirstSeenStamp {
  return { on: r.first_seen_on, at: r.first_seen_at, seq: r.first_seen_seq };
}

/**
 * A flow's arrival, as the carry rule reads it:
 *
 * - `stamped`: the flow has a stamp.
 * - `before_stamps`: no stamp, so it was on file before the stamps existed (every insert since
 *   stamps its row: a card line, a movement, a manual expense, a plan): older than any stamp. A
 *   flow whose rows are gone (retired, kept by its assignments) is one too.
 * - `not_an_arrival`: no stamp, and every row it records is a statement's cuota line (its monthly
 *   billing of a plan: never a new movement, so the import stamps none). It neither gives nor takes
 *   a place.
 */
export type FlowArrival = { kind: "stamped"; stamp: FirstSeenStamp } | { kind: "before_stamps" } | { kind: "not_an_arrival" };

/** The flow's arrival (see {@link FlowArrival}). */
export function flowArrival(flowId: number, dbHandle: Database = db): FlowArrival {
  const row = dbHandle
    .prepare(`SELECT first_seen_on, first_seen_at, first_seen_seq FROM flow_first_seen WHERE flow_id = ?`)
    .get(flowId) as StampRow | undefined;
  if (row) return { kind: "stamped", stamp: stampOf(row) };
  const evidence = dbHandle
    .prepare(
      `SELECT COUNT(*) AS n,
         SUM(CASE WHEN e.source_table = 'cc_statement_lines' AND EXISTS (
           SELECT 1 FROM cc_statement_lines l JOIN cc_statements s ON s.id = l.statement_id
           WHERE l.id = e.source_row_id AND l.installment_flag = 1 AND s.source_kind NOT IN ('listing_open', 'listing_other')
         ) THEN 1 ELSE 0 END) AS cuota
       FROM flow_evidence e WHERE e.flow_id = ?`
    )
    .get(flowId) as { n: number; cuota: number | null };
  return evidence.n > 0 && evidence.cuota === evidence.n ? { kind: "not_an_arrival" } : { kind: "before_stamps" };
}

/** Whether `a` is the earlier stamp: by day, then time, then order (a missing time or order counts as earlier). */
function stampIsEarlier(a: FirstSeenStamp, b: FirstSeenStamp): boolean {
  const key = (s: FirstSeenStamp) => [s.on, s.at ?? "", s.seq ?? 0] as const;
  const [ka, kb] = [key(a), key(b)];
  if (ka[0] !== kb[0]) return ka[0] < kb[0];
  if (ka[1] !== kb[1]) return ka[1] < kb[1];
  return ka[2] < kb[2];
}

/**
 * THE carry rule, for every path that folds one flow's arrival into another's (a flow merge, a
 * re-imported or settled line taking over a flow, a debit reshaped into a card payment): the result
 * is the older arrival. A flow on file before the stamps is older than any stamp, so it wins and the
 * result is unstamped (a newer row's stamp never lands on it); between two stamps the earlier
 * stays; a statement cuota line's own flow changes nothing. A genuinely new row whose flow absorbs
 * nothing old keeps its own stamp.
 */
export function olderArrival(a: FlowArrival, b: FlowArrival): FlowArrival {
  if (a.kind === "before_stamps" || b.kind === "before_stamps") return { kind: "before_stamps" };
  if (a.kind === "not_an_arrival") return b;
  if (b.kind === "not_an_arrival") return a;
  return stampIsEarlier(a.stamp, b.stamp) ? a : b;
}

/** Writes an arrival onto a flow: its stamp, or none. */
export function setFlowArrival(flowId: number, arrival: FlowArrival, dbHandle: Database = db): void {
  if (arrival.kind !== "stamped") {
    dbHandle.prepare(`DELETE FROM flow_first_seen WHERE flow_id = ?`).run(flowId);
    return;
  }
  const { on, at, seq } = arrival.stamp;
  dbHandle
    .prepare(
      `INSERT INTO flow_first_seen (flow_id, first_seen_on, first_seen_at, first_seen_seq) VALUES (?, ?, ?, ?)
       ON CONFLICT(flow_id) DO UPDATE SET
         first_seen_on = excluded.first_seen_on, first_seen_at = excluded.first_seen_at, first_seen_seq = excluded.first_seen_seq`
    )
    .run(flowId, on, at, seq);
}

/**
 * `to` takes the older arrival of the two ({@link olderArrival}); `from` keeps its own: a row that
 * replaces another under a new flow (a checking debit converted into a card payment) keeps the
 * place the replaced row had in «Últimos movimientos», and none when the replaced row had none.
 */
export function copyFlowFirstSeen(from: number, to: number, dbHandle: Database = db): void {
  if (from === to) return;
  setFlowArrival(to, olderArrival(flowArrival(from, dbHandle), flowArrival(to, dbHandle)), dbHandle);
}

/**
 * Folds `from`'s arrival into `to` ({@link olderArrival}) and removes `from`'s stamp. `arrival`: the
 * result read before the caller moved `from`'s rows (a merge moves the evidence first, which
 * changes what `to` records); read now when omitted.
 */
export function carryFlowFirstSeen(from: number, to: number, dbHandle: Database = db, arrival?: FlowArrival): void {
  if (from === to) return;
  setFlowArrival(to, arrival ?? olderArrival(flowArrival(from, dbHandle), flowArrival(to, dbHandle)), dbHandle);
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
