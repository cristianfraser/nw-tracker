/**
 * The order of one day's rows in the home «Últimos movimientos» (`latestMovements.ts`).
 *
 * Rows carry no time of their own, so the order comes from what the sources say about the moment:
 *
 * - a STATED time: the source document names the moment (a Racional row's creation instant, the
 *   dollar account feed's operation time — `flow_event_times` —, a processor receipt's payment
 *   time, a grocery receipt's printed time). The first in that order wins, and only when it falls
 *   on the row's own Chile day (a Saturday boleta whose bank line is dated Monday says nothing
 *   about Monday).
 * - UPPER BOUNDS: moments the money had moved by (the row's write stamp `flow_first_seen.first_seen_at`,
 *   a transfer mail's sent time, a broker mail's time in `movement_event_times`). The earliest
 *   counts, clamped into the row's day: a row first written on a later day sorts as the end of
 *   its own day, since it was not in that day's last read.
 *
 * Then the write order (`first_seen_seq`: a listing's printed order within one read), then the
 * id order. Display only: a time no source gives is null and sorts after the timed rows; nothing
 * here throws on a disagreement between sources.
 */
import { addDaysIso } from "nw-tracker-contracts";
import { chileWallTimeToInstant } from "./chileDate.js";
import type { FlowCcExpenseLineRow } from "./expenseLineTypes.js";

/** What a row is, for the sources of its moment. */
export type LatestRowRef =
  | { kind: "line"; line: FlowCcExpenseLineRow }
  | { kind: "movement"; movementId: number; accountId: number }
  | { kind: "none" };

/** What the sources say about when one row's money moved. */
export type LatestRowTimes = {
  /** Stated times (epoch ms), best source first. */
  stated: readonly number[];
  /** Upper bounds (epoch ms). */
  bounds: readonly number[];
  /** Write order (`first_seen_seq`); null for a row written before it existed. */
  seq: number | null;
};

/** The moments the sources give each row, in the order asked (`latestMovementTimes.ts`). */
export type LatestRowTimesResolver = (refs: readonly LatestRowRef[]) => LatestRowTimes[];

export type LatestRowOrderKey = { atMs: number | null; seq: number | null };

const dayStartMs = new Map<string, number>();
function chileDayStartMs(ymd: string): number {
  let ms = dayStartMs.get(ymd);
  if (ms === undefined) {
    ms = chileWallTimeToInstant(`${ymd} 00:00`).getTime();
    dayStartMs.set(ymd, ms);
  }
  return ms;
}

/** The row's moment for ordering inside its day `on` (see the header). */
export function latestRowOrderKey(on: string, times: LatestRowTimes): LatestRowOrderKey {
  const start = chileDayStartMs(on);
  const end = chileDayStartMs(addDaysIso(on, 1)) - 1;
  const stated = times.stated.find((ms) => ms >= start && ms <= end);
  if (stated !== undefined) return { atMs: stated, seq: times.seq };
  if (times.bounds.length === 0) return { atMs: null, seq: times.seq };
  const bound = Math.min(...times.bounds);
  return { atMs: Math.min(Math.max(bound, start), end), seq: times.seq };
}

/** Newest first: the later moment, then the later write, a missing one last. */
export function compareLatestRowOrderKeys(a: LatestRowOrderKey, b: LatestRowOrderKey): number {
  return descNullsLast(a.atMs, b.atMs) || descNullsLast(a.seq, b.seq);
}

function descNullsLast(a: number | null, b: number | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return b - a;
}
