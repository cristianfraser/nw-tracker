/**
 * When the live prices the app shows last moved, and what moved, for the client to refetch on
 * (2026-10-27; what moved since 2026-11-04).
 *
 * The client polls `GET /api/live-quotes/stamp?since=<the stamp it last saw>` and, when the stamp
 * changed, refetches only the queries whose response read a price that moved since then (each
 * response names the live inputs it read, `X-Live-Inputs`, `liveInputsHeader.ts`).
 *
 * A change is published at once: the responses it drops are rebuilt by the first request that
 * needs them, on top of the cached history (the warmer no longer rebuilds on a price change).
 *
 * Moves are kept in a bounded log. A `since` the log cannot answer — older than its oldest entry
 * once it has dropped some, or from before this process started — reads as "everything moved".
 */

export type LiveQuoteMoveSet = {
  /** Unknown or everything (a fresh process, a truncated log, the day's `fx_daily` close). */
  all: boolean;
  tickers: string[];
  fx: boolean;
  /** The dashboard's sync dimming changed (`syncDimmingWatch.ts`). */
  dimming: boolean;
};

export type LiveQuoteMove = {
  tickers?: readonly string[];
  fx?: boolean;
  dimming?: boolean;
  all?: boolean;
};

type LogEntry = { at: string; move: LiveQuoteMove };

const MAX_LOG_ENTRIES = 500;

let log: LogEntry[] = [];
/** Moves at or before this instant are not in the log: process start, then the last dropped entry. */
let knownSince = new Date().toISOString();
let publishedAt: string | null = null;

/** A write moved live prices at `at` (ISO): log what moved and publish the stamp. */
export function noteLiveQuotesChanged(at: string, move: LiveQuoteMove): void {
  log.push({ at, move });
  if (log.length > MAX_LOG_ENTRIES) {
    const dropped = log.splice(0, log.length - MAX_LOG_ENTRIES);
    knownSince = dropped[dropped.length - 1]!.at;
  }
  if (publishedAt == null || at > publishedAt) publishedAt = at;
}

export function liveQuotesStamp(): string | null {
  return publishedAt;
}

/** What moved after `since` (a stamp the client saw), or null when nothing did. */
export function liveQuoteMovesSince(since: string | null | undefined): LiveQuoteMoveSet | null {
  if (since == null || since === "" || since < knownSince) {
    return publishedAt == null ? null : { all: true, tickers: [], fx: false, dimming: false };
  }
  const tickers = new Set<string>();
  const set: LiveQuoteMoveSet = { all: false, tickers: [], fx: false, dimming: false };
  let any = false;
  for (const { at, move } of log) {
    if (at <= since) continue;
    any = true;
    if (move.all) set.all = true;
    if (move.fx) set.fx = true;
    if (move.dimming) set.dimming = true;
    for (const t of move.tickers ?? []) tickers.add(t.toUpperCase());
  }
  if (!any) return null;
  set.tickers = [...tickers].sort();
  return set;
}

/** Tests only. */
export function resetLiveQuotesStampForTest(startedAt: string): void {
  log = [];
  knownSince = startedAt;
  publishedAt = null;
}
