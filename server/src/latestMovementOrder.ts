/**
 * The order of the home «Últimos movimientos» (`latestMovements.ts`): a feed of what reached the
 * app, newest arrival on top. A row's own date stays its date everywhere (ledgers, expenses, this
 * list's label); only the order here follows arrival, so a movement recorded today for a week ago
 * shows on top.
 *
 * - **Arrival batch.** A row arrives with its write stamp (`flow_first_seen.first_seen_at`). Writes
 *   inside one ingest run (`ingest_runs` start → finish) are one batch, dated at the run's start;
 *   any other write (a hand entry, an upload) is a batch of its own. The later batch is on top.
 * - **Inside a batch, when it happened**, newest first: the first stated time (the flow's own
 *   document, a paired processor or grocery receipt), else the earliest upper bound a source gives
 *   (a transfer or broker mail's time), else the middle of the window the row could have happened
 *   in — after the previous run started (that run did not bring it), before it was written. Then
 *   the write order (`first_seen_seq`: a listing's printed order), then the id.
 * - Rows written before the stamps existed (migration 367) follow every stamped row, by day.
 *
 * Display only: sources that disagree never throw.
 */
import type { FlowCcExpenseLineRow } from "./expenseLineTypes.js";

/** What a row is, for the sources of its moment. */
export type LatestRowRef =
  | { kind: "line"; line: FlowCcExpenseLineRow }
  | { kind: "movement"; movementId: number; accountId: number }
  | { kind: "none" };

/** When the app first wrote a row (`flow_first_seen`). */
export type LatestWriteStamp = { atMs: number; seq: number };

/** What the sources say about when a row's money moved (write stamp aside). */
export type LatestRowTimes = {
  /** Stated times (epoch ms), best source first. */
  stated: readonly number[];
  /** Upper bounds (epoch ms): mail times. */
  bounds: readonly number[];
};

/** An ingest run's window (epoch ms). */
export type ArrivalRun = { startedMs: number; endMs: number };

/** The rows' arrival and moments, from the database (`latestMovementTimes.ts`) or a test. */
export type LatestRowSources = {
  stamps: (refs: readonly LatestRowRef[]) => (LatestWriteStamp | null)[];
  /** Ingest runs, oldest first. */
  runs: readonly ArrivalRun[];
  times: (refs: readonly LatestRowRef[]) => LatestRowTimes[];
};

/** The batch a write belongs to: its run (dated at the run's start) or itself. */
export type ArrivalBatch = { atMs: number; prevRunStartMs: number | null };

/** The batch of a write at `atMs` (`runs` oldest first). */
export function arrivalBatchOf(atMs: number, runs: readonly ArrivalRun[]): ArrivalBatch {
  for (let i = runs.length - 1; i >= 0; i--) {
    const run = runs[i]!;
    if (run.startedMs > atMs) continue;
    if (atMs <= run.endMs) return { atMs: run.startedMs, prevRunStartMs: i > 0 ? runs[i - 1]!.startedMs : null };
    return { atMs, prevRunStartMs: null };
  }
  return { atMs, prevRunStartMs: null };
}

/** When a row in `batch` most likely happened (see the header). */
export function happenedEstimateMs(times: LatestRowTimes, stamp: LatestWriteStamp, batch: ArrivalBatch): number {
  const stated = times.stated[0];
  if (stated !== undefined) return stated;
  if (times.bounds.length > 0) return Math.min(...times.bounds);
  if (batch.prevRunStartMs !== null && batch.prevRunStartMs < stamp.atMs) {
    return Math.round((batch.prevRunStartMs + stamp.atMs) / 2);
  }
  return stamp.atMs;
}

/** A row's place: stamped rows by batch, then moment, then write order; the rest by day. */
export type LatestRowOrderKey =
  | { stamped: true; batchAtMs: number; happenedMs: number; seq: number }
  | { stamped: false; on: string };

/** Newest first (a row's id order breaks the last tie, outside). */
export function compareLatestRowOrderKeys(a: LatestRowOrderKey, b: LatestRowOrderKey): number {
  if (a.stamped && b.stamped) {
    return b.batchAtMs - a.batchAtMs || b.happenedMs - a.happenedMs || b.seq - a.seq;
  }
  if (a.stamped) return -1;
  if (b.stamped) return 1;
  return b.on.localeCompare(a.on);
}
